# signaling/server.py
import asyncio
import json
import os
from dataclasses import dataclass, field
from typing import Optional, Dict, List

import jwt as pyjwt
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

# ── Config ────────────────────────────────────────────────────────────────────
APP_JWT_SECRET   = os.environ.get("APP_JWT_SECRET",   "change-me")
APP_JWT_ISSUER   = os.environ.get("APP_JWT_ISSUER",   "my-thin-bridge")
APP_JWT_AUDIENCE = os.environ.get("APP_JWT_AUDIENCE", "my-attached-app")

DEFAULT_SPEAKER_TIME   = 60    # seconds
MOTION_PENDING_TIMEOUT = 30    # seconds
SECONDED_TIMEOUT       = 300   # 5 minutes
VOTE_CLOSED_DISPLAY    = 5     # seconds

# ── Dataclasses ───────────────────────────────────────────────────────────────
@dataclass
class Member:
    id: str
    name: str
    is_chair: bool = False
    hand_raised: bool = False

@dataclass
class Motion:
    text: str
    moved_by: str
    seconded_by: Optional[str] = None
    votes: Dict = field(default_factory=lambda: {"yea": 0, "nay": 0, "abstain": 0})
    member_votes: Dict = field(default_factory=dict)
    result: Optional[str] = None

@dataclass
class Room:
    room_id: str
    phase: str = "open"
    members: List = field(default_factory=list)
    speaker_queue: List = field(default_factory=list)
    current_speaker: Optional[str] = None
    timer_remaining: int = DEFAULT_SPEAKER_TIME
    speaker_time: int = DEFAULT_SPEAKER_TIME
    motion: Optional[Motion] = None
    # Saved state for restoring after motion_pending
    _prev_phase: Optional[str]   = field(default=None, repr=False)
    _prev_speaker: Optional[str] = field(default=None, repr=False)
    _prev_timer: int              = field(default=0,    repr=False)

# ── Global state (asyncio single-threaded — no locks needed) ─────────────────
rooms:         Dict[str, Room]                   = {}
connections:   Dict[str, Dict[str, WebSocket]]   = {}
_timer_tasks:  Dict[str, asyncio.Task]           = {}
_motion_tasks: Dict[str, asyncio.Task]           = {}

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

# ── Auth ──────────────────────────────────────────────────────────────────────
def _validate_jwt(token: str) -> dict:
    return pyjwt.decode(
        token, APP_JWT_SECRET,
        algorithms=["HS256"],
        issuer=APP_JWT_ISSUER,
        audience=APP_JWT_AUDIENCE,
    )

# ── Helpers ───────────────────────────────────────────────────────────────────
def _room_to_dict(room: Room) -> dict:
    return {
        "room_id": room.room_id,
        "phase": room.phase,
        "members": [
            {"id": m.id, "name": m.name,
             "is_chair": m.is_chair, "hand_raised": m.hand_raised}
            for m in room.members
        ],
        "speaker_queue": list(room.speaker_queue),
        "current_speaker": room.current_speaker,
        "timer_remaining": room.timer_remaining,
        "speaker_time": room.speaker_time,
        "motion": {
            "text": room.motion.text,
            "moved_by": room.motion.moved_by,
            "seconded_by": room.motion.seconded_by,
            "votes": dict(room.motion.votes),
            "member_votes": dict(room.motion.member_votes),
            "result": room.motion.result,
        } if room.motion else None,
    }

def _get_member(room: Room, member_id: str) -> Optional[Member]:
    return next((m for m in room.members if m.id == member_id), None)

def _is_chair(room: Room, member_id: str) -> bool:
    m = _get_member(room, member_id)
    return m is not None and m.is_chair

def _cancel_task(task_dict: dict, key: str) -> None:
    task = task_dict.pop(key, None)
    if task and not task.done():
        task.cancel()

async def _broadcast(room_id: str, msg: dict) -> None:
    text = json.dumps(msg)
    for ws in list(connections.get(room_id, {}).values()):
        try:
            await ws.send_text(text)
        except Exception:
            pass

async def _broadcast_state(room_id: str) -> None:
    room = rooms.get(room_id)
    if room:
        await _broadcast(room_id, {"type": "state", "state": _room_to_dict(room)})

async def _send_error(ws: WebSocket, message: str) -> None:
    try:
        await ws.send_text(json.dumps({"type": "error", "message": message}))
    except Exception:
        pass
