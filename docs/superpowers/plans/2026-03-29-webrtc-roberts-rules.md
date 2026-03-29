# WebRTC Roberts Rules Meeting Room — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a real-time Roberts Rules of Order meeting room with WebRTC audio/video, automated speaker queue, 60-second timer, and motion/vote workflow.

**Architecture:** FastAPI WebSocket signaling server (`signaling/server.py`) manages Roberts Rules state machine and relays WebRTC SDP/ICE. Vanilla JS frontend (`webrtc/`) connects via WebSocket, establishes mesh peer connections, and renders UI driven entirely by server-broadcast state snapshots.

**Tech Stack:** Python 3.11+, FastAPI, PyJWT, asyncio. Vanilla JS ES modules, WebRTC browser APIs. No build tooling.

**Spec:** `docs/superpowers/specs/2026-03-29-webrtc-roberts-rules-design.md`

---

## Chunk 1: Signaling server

### Task 1: `signaling/requirements.txt`

**Files:**
- Create: `signaling/requirements.txt`

- [ ] **Step 1: Create the file**

```
fastapi>=0.110.0
uvicorn[standard]>=0.29.0
websockets>=12.0
pyjwt>=2.8.0
pytest>=8.0.0
pytest-asyncio>=0.23.0
httpx>=0.27.0
```

- [ ] **Step 2: Create `signaling/pytest.ini`**

```ini
[pytest]
asyncio_mode = auto
```

This is required for `pytest-asyncio >= 0.21` — without it, all `@pytest.mark.asyncio` tests fail with "no event loop" errors.

- [ ] **Step 3: Install and verify**

```bash
cd signaling && pip install -r requirements.txt
python -c "import fastapi, jwt, websockets; print('ok')"
```

Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add signaling/requirements.txt signaling/pytest.ini
git commit -m "chore: add signaling server requirements and pytest config"
```

---

### Task 2: `signaling/server.py` — core state + auth

**Files:**
- Create: `signaling/server.py`
- Create: `signaling/test_server.py`

- [ ] **Step 1: Write the failing test for JWT validation**

Create `signaling/test_server.py`:

```python
import pytest
import jwt as pyjwt
import os
# Use unconditional assignment so env vars are set before server.py is imported
# (server.py reads them at module level; setdefault would be unsafe if env was pre-set)
os.environ["APP_JWT_SECRET"]   = "test-secret"
os.environ["APP_JWT_ISSUER"]   = "my-thin-bridge"
os.environ["APP_JWT_AUDIENCE"] = "my-attached-app"

from server import _validate_jwt, Room, Member, Motion

SECRET = "test-secret"

def make_token(sub="user1", name="Alice", exp_offset=3600):
    import time
    return pyjwt.encode(
        {"sub": sub, "name": name, "iss": "my-thin-bridge",
         "aud": "my-attached-app", "exp": int(time.time()) + exp_offset},
        SECRET, algorithm="HS256"
    )

def test_validate_jwt_valid():
    token = make_token()
    claims = _validate_jwt(token)
    assert claims["sub"] == "user1"

def test_validate_jwt_expired():
    token = make_token(exp_offset=-10)
    with pytest.raises(Exception):
        _validate_jwt(token)

def test_validate_jwt_wrong_audience():
    import time
    bad = pyjwt.encode(
        {"sub": "x", "iss": "my-thin-bridge", "aud": "wrong", "exp": int(time.time()) + 3600},
        SECRET, algorithm="HS256"
    )
    with pytest.raises(Exception):
        _validate_jwt(bad)
```

- [ ] **Step 2: Run to confirm they fail**

```bash
cd signaling && pytest test_server.py -v 2>&1 | head -20
```

Expected: `ModuleNotFoundError: No module named 'server'`

- [ ] **Step 3: Create `signaling/server.py` with config, dataclasses, and `_validate_jwt`**

```python
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
```

- [ ] **Step 4: Run auth tests**

```bash
cd signaling && pytest test_server.py::test_validate_jwt_valid test_server.py::test_validate_jwt_expired test_server.py::test_validate_jwt_wrong_audience -v
```

Expected: all 3 PASS

---

### Task 3: `signaling/server.py` — state helpers + broadcast

**Files:**
- Modify: `signaling/server.py`
- Modify: `signaling/test_server.py`

- [ ] **Step 1: Write tests for state helpers**

Append to `signaling/test_server.py`:

```python
def test_room_to_dict_no_motion():
    from server import _room_to_dict
    room = Room(room_id="r1")
    room.members.append(Member(id="u1", name="Alice", is_chair=True))
    d = _room_to_dict(room)
    assert d["room_id"] == "r1"
    assert d["phase"] == "open"
    assert d["motion"] is None
    assert d["members"][0]["is_chair"] is True

def test_get_member_found():
    from server import _get_member
    room = Room(room_id="r1")
    room.members.append(Member(id="u1", name="Alice"))
    assert _get_member(room, "u1").name == "Alice"

def test_get_member_not_found():
    from server import _get_member
    room = Room(room_id="r1")
    assert _get_member(room, "nope") is None

def test_is_chair():
    from server import _is_chair
    room = Room(room_id="r1")
    room.members.append(Member(id="u1", name="Alice", is_chair=True))
    room.members.append(Member(id="u2", name="Bob"))
    assert _is_chair(room, "u1") is True
    assert _is_chair(room, "u2") is False
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd signaling && pytest test_server.py::test_room_to_dict_no_motion -v 2>&1 | head -5
```

Expected: `ImportError` or `AttributeError`

- [ ] **Step 3: Append helpers to `signaling/server.py`**

```python
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
```

- [ ] **Step 4: Run helper tests**

```bash
cd signaling && pytest test_server.py::test_room_to_dict_no_motion test_server.py::test_get_member_found test_server.py::test_get_member_not_found test_server.py::test_is_chair -v
```

Expected: all 4 PASS

---

### Task 4: `signaling/server.py` — timer + speaker advance

**Files:**
- Modify: `signaling/server.py`
- Modify: `signaling/test_server.py`

- [ ] **Step 1: Write tests for speaker advance logic**

Append to `signaling/test_server.py`:

```python
import pytest_asyncio

@pytest.mark.asyncio
async def test_advance_speaker_no_queue():
    import server as srv
    srv.rooms.clear(); srv.connections.clear(); srv._timer_tasks.clear()
    room = Room(room_id="r1", phase="floor_held",
                current_speaker="u1", speaker_queue=[])
    room.members.append(Member(id="u1", name="Alice"))
    srv.rooms["r1"] = room
    srv.connections["r1"] = {}
    await srv._advance_speaker("r1")
    assert room.phase == "open"
    assert room.current_speaker is None

@pytest.mark.asyncio
async def test_advance_speaker_with_queue():
    import server as srv
    srv.rooms.clear(); srv.connections.clear(); srv._timer_tasks.clear()
    room = Room(room_id="r2", phase="floor_held",
                current_speaker="u1", speaker_queue=["u2"],
                speaker_time=60)
    room.members += [Member(id="u1", name="Alice"), Member(id="u2", name="Bob")]
    srv.rooms["r2"] = room
    srv.connections["r2"] = {}
    await srv._advance_speaker("r2")
    assert room.current_speaker == "u2"
    assert room.phase == "floor_held"
    assert room.timer_remaining == 60
    # Cancel the new timer so it doesn't run during test
    srv._cancel_task(srv._timer_tasks, "r2")

@pytest.mark.asyncio
async def test_advance_speaker_guard_double_call():
    import server as srv
    srv.rooms.clear(); srv.connections.clear(); srv._timer_tasks.clear()
    room = Room(room_id="r3", phase="open", current_speaker=None)
    srv.rooms["r3"] = room
    srv.connections["r3"] = {}
    # Should be a no-op
    await srv._advance_speaker("r3")
    assert room.phase == "open"
```

- [ ] **Step 2: Confirm tests fail**

```bash
cd signaling && pytest test_server.py::test_advance_speaker_no_queue -v 2>&1 | head -5
```

Expected: `ImportError` (function not yet defined)

- [ ] **Step 3: Append timer functions to `signaling/server.py`**

```python
# ── Timer & background tasks ──────────────────────────────────────────────────
async def _run_speaker_timer(room_id: str) -> None:
    """Ticks speaker timer every second; auto-advances at 0."""
    try:
        while True:
            await asyncio.sleep(1)
            room = rooms.get(room_id)
            if not room or room.current_speaker is None:
                return
            room.timer_remaining = max(0, room.timer_remaining - 1)
            await _broadcast_state(room_id)
            if room.timer_remaining == 0:
                await _advance_speaker(room_id)
                return
    except asyncio.CancelledError:
        pass

async def _advance_speaker(room_id: str) -> None:
    """Grant floor to next speaker. Guards against double-call via current_speaker check."""
    room = rooms.get(room_id)
    if not room or room.current_speaker is None:
        return  # already advanced — guard

    _cancel_task(_timer_tasks, room_id)

    prev = _get_member(room, room.current_speaker)
    if prev:
        prev.hand_raised = False
    room.current_speaker = None

    if room.speaker_queue:
        next_id = room.speaker_queue.pop(0)
        room.current_speaker = next_id
        room.timer_remaining = room.speaker_time
        room.phase = "floor_held"
        _timer_tasks[room_id] = asyncio.create_task(_run_speaker_timer(room_id))
    else:
        room.phase = "open"

    await _broadcast_state(room_id)

async def _motion_pending_timeout(room_id: str) -> None:
    try:
        await asyncio.sleep(MOTION_PENDING_TIMEOUT)
        room = rooms.get(room_id)
        if room and room.phase == "motion_pending":
            await _restore_prev_phase(room_id)
    except asyncio.CancelledError:
        pass

async def _seconded_timeout(room_id: str) -> None:
    try:
        await asyncio.sleep(SECONDED_TIMEOUT)
        room = rooms.get(room_id)
        if room and room.phase == "seconded":
            room.phase = "open"
            room.motion = None
            # Clear saved prev-state to prevent stale data
            room._prev_phase = room._prev_speaker = None
            room._prev_timer = 0
            await _broadcast_state(room_id)
    except asyncio.CancelledError:
        pass

async def _restore_prev_phase(room_id: str) -> None:
    room = rooms.get(room_id)
    if not room:
        return
    _cancel_task(_motion_tasks, room_id)
    room.motion   = None
    room.phase    = room._prev_phase or "open"
    room.current_speaker = room._prev_speaker
    room.timer_remaining = room._prev_timer
    room._prev_phase = room._prev_speaker = None
    room._prev_timer = 0
    if room.current_speaker and room.phase == "floor_held":
        _timer_tasks[room_id] = asyncio.create_task(_run_speaker_timer(room_id))
    await _broadcast_state(room_id)

async def _close_vote(room_id: str) -> None:
    room = rooms.get(room_id)
    if not room or not room.motion:
        return
    yea = room.motion.votes["yea"]
    nay = room.motion.votes["nay"]
    room.motion.result = "passed" if yea > nay else "failed"
    room.phase = "vote_closed"
    await _broadcast_state(room_id)
    await asyncio.sleep(VOTE_CLOSED_DISPLAY)
    room = rooms.get(room_id)
    if room:
        room.phase  = "open"
        room.motion = None
        await _broadcast_state(room_id)
```

- [ ] **Step 4: Run timer tests**

```bash
cd signaling && pytest test_server.py -k "advance_speaker" -v
```

Expected: all 3 PASS

---

### Task 5: `signaling/server.py` — leave handler + message handler + WebSocket endpoint

**Files:**
- Modify: `signaling/server.py`
- Modify: `signaling/test_server.py`

- [ ] **Step 1: Write test for leave / chair promotion**

Append to `signaling/test_server.py`:

```python
@pytest.mark.asyncio
async def test_handle_leave_promotes_chair():
    import server as srv
    srv.rooms.clear(); srv.connections.clear(); srv._timer_tasks.clear()
    room = Room(room_id="r4")
    room.members += [
        Member(id="chair", name="Chair", is_chair=True),
        Member(id="u2", name="Bob"),
    ]
    srv.rooms["r4"] = room
    srv.connections["r4"] = {}
    await srv._handle_leave("r4", "chair")
    assert room.members[0].id == "u2"
    assert room.members[0].is_chair is True

@pytest.mark.asyncio
async def test_handle_leave_last_member_destroys_room():
    import server as srv
    srv.rooms.clear(); srv.connections.clear()
    room = Room(room_id="r5")
    room.members.append(Member(id="u1", name="Alice", is_chair=True))
    srv.rooms["r5"] = room
    srv.connections["r5"] = {}
    await srv._handle_leave("r5", "u1")
    assert "r5" not in srv.rooms
```

- [ ] **Step 2: Confirm tests fail**

```bash
cd signaling && pytest test_server.py -k "leave" -v 2>&1 | head -10
```

Expected: `ImportError`

- [ ] **Step 3: Append leave handler, message handler, and WebSocket endpoint to `signaling/server.py`**

```python
# ── Leave ─────────────────────────────────────────────────────────────────────
async def _handle_leave(room_id: str, member_id: str) -> None:
    room = rooms.get(room_id)
    if not room:
        return
    connections.get(room_id, {}).pop(member_id, None)
    was_chair   = _is_chair(room, member_id)
    was_speaker = room.current_speaker == member_id
    room.members       = [m for m in room.members       if m.id != member_id]
    room.speaker_queue = [x for x in room.speaker_queue if x != member_id]

    if not room.members:
        _cancel_task(_timer_tasks,  room_id)
        _cancel_task(_motion_tasks, room_id)
        rooms.pop(room_id, None)
        connections.pop(room_id, None)
        return

    if was_chair:
        room.members[0].is_chair = True

    if was_speaker:
        room.current_speaker = None  # clear before advance to prevent double-call
        _cancel_task(_timer_tasks, room_id)
        if room.speaker_queue:
            nxt = room.speaker_queue.pop(0)
            room.current_speaker  = nxt
            room.timer_remaining  = room.speaker_time
            room.phase            = "floor_held"
            _timer_tasks[room_id] = asyncio.create_task(_run_speaker_timer(room_id))
        elif room.phase == "floor_held":
            room.phase = "open"

    if room.phase == "voting" and was_chair:
        asyncio.create_task(_close_vote(room_id))
        return

    await _broadcast_state(room_id)

# ── Message handler ───────────────────────────────────────────────────────────
async def _handle_message(room_id: str, member_id: str,
                           ws: WebSocket, msg: dict) -> None:
    room = rooms.get(room_id)
    if not room:
        return
    mtype = msg.get("type")

    # WebRTC relay
    if mtype in ("offer", "answer", "ice"):
        to = msg.get("to")
        target = connections.get(room_id, {}).get(to)
        if target:
            await target.send_text(json.dumps({
                "type": "signal", "from": member_id, "signal_type": mtype,
                **{k: v for k, v in msg.items() if k not in ("type", "to")},
            }))
        return

    if mtype == "raise_hand":
        if room.phase not in ("open", "floor_held", "seconded"):
            return await _send_error(ws, "cannot raise hand in current phase")
        m = _get_member(room, member_id)
        if m and not m.hand_raised and member_id not in room.speaker_queue:
            m.hand_raised = True
            room.speaker_queue.append(member_id)
            if room.phase == "open" and room.current_speaker is None:
                nxt = room.speaker_queue.pop(0)
                room.current_speaker  = nxt
                room.timer_remaining  = room.speaker_time
                room.phase            = "floor_held"
                _timer_tasks[room_id] = asyncio.create_task(_run_speaker_timer(room_id))
            await _broadcast_state(room_id)
        return

    if mtype == "lower_hand":
        if room.phase not in ("open", "floor_held", "seconded"):
            return await _send_error(ws, "cannot lower hand in current phase")
        m = _get_member(room, member_id)
        if m:
            m.hand_raised = False
            room.speaker_queue = [x for x in room.speaker_queue if x != member_id]
            await _broadcast_state(room_id)
        return

    if mtype == "yield_floor":
        if room.phase != "floor_held" or room.current_speaker != member_id:
            return await _send_error(ws, "not your floor to yield")
        await _advance_speaker(room_id)
        return

    if mtype == "make_motion":
        if room.phase not in ("open", "floor_held", "seconded"):
            return await _send_error(ws, "cannot make motion in current phase")
        # Block making a new motion while a motion is already seconded and under debate
        if room.phase == "seconded":
            return await _send_error(ws, "a motion is already under debate; withdraw it first")
        text = (msg.get("text") or "").strip()
        if not text:
            return await _send_error(ws, "motion text required")
        _cancel_task(_timer_tasks, room_id)
        # Also cancel any pending motion timeout (e.g., lingering _motion_pending_timeout)
        _cancel_task(_motion_tasks, room_id)
        room._prev_phase   = room.phase
        room._prev_speaker = room.current_speaker
        room._prev_timer   = room.timer_remaining
        room.phase  = "motion_pending"
        room.motion = Motion(text=text, moved_by=member_id)
        _motion_tasks[room_id] = asyncio.create_task(_motion_pending_timeout(room_id))
        await _broadcast_state(room_id)
        return

    if mtype == "second_motion":
        if room.phase != "motion_pending":
            return await _send_error(ws, "no motion pending")
        if not room.motion or room.motion.moved_by == member_id:
            return await _send_error(ws, "mover cannot second their own motion")
        _cancel_task(_motion_tasks, room_id)
        room.motion.seconded_by = member_id
        room.phase = "seconded"
        _motion_tasks[room_id] = asyncio.create_task(_seconded_timeout(room_id))
        await _broadcast_state(room_id)
        return

    if mtype == "withdraw_motion":
        if room.phase not in ("motion_pending", "seconded"):
            return await _send_error(ws, "no active motion to withdraw")
        if not room.motion or room.motion.moved_by != member_id:
            return await _send_error(ws, "only the mover can withdraw")
        await _restore_prev_phase(room_id)
        return

    if mtype == "call_vote":
        if not _is_chair(room, member_id):
            return await _send_error(ws, "only the chair can call a vote")
        if room.phase != "seconded":
            return await _send_error(ws, "can only call vote in seconded phase")
        _cancel_task(_motion_tasks, room_id)
        room.phase = "voting"
        await _broadcast_state(room_id)
        return

    if mtype == "cast_vote":
        if room.phase != "voting" or not room.motion:
            return await _send_error(ws, "not in voting phase")
        if member_id in room.motion.member_votes:
            return await _send_error(ws, "already voted")
        vote = msg.get("vote")
        if vote not in ("yea", "nay", "abstain"):
            return await _send_error(ws, "vote must be yea, nay, or abstain")
        room.motion.member_votes[member_id] = vote
        room.motion.votes[vote] += 1
        if len(room.motion.member_votes) >= len(room.members):
            asyncio.create_task(_close_vote(room_id))
        else:
            await _broadcast_state(room_id)
        return

    if mtype == "set_speaker_time":
        if not _is_chair(room, member_id):
            return await _send_error(ws, "only the chair can set speaker time")
        if room.phase != "open":
            return await _send_error(ws, "can only set speaker time in open phase")
        if room.current_speaker is not None:
            return await _send_error(ws, "cannot change speaker time while someone has the floor")
        secs = msg.get("seconds")
        if not isinstance(secs, int) or not (10 <= secs <= 600):
            return await _send_error(ws, "speaker_time must be 10–600 seconds")
        room.speaker_time = secs
        await _broadcast_state(room_id)
        return

    if mtype == "leave":
        await _handle_leave(room_id, member_id)
        await ws.close()
        return

# ── WebSocket endpoint ────────────────────────────────────────────────────────
@app.websocket("/ws/{room_id}")
async def ws_endpoint(websocket: WebSocket, room_id: str) -> None:
    await websocket.accept()
    member_id: Optional[str] = None
    try:
        raw = await websocket.receive_text()
        msg = json.loads(raw)
        if msg.get("type") != "join":
            await _send_error(websocket, "first message must be join")
            return await websocket.close()
        try:
            claims = _validate_jwt(msg["token"])
        except Exception:
            await _send_error(websocket, "unauthorized")
            return await websocket.close()

        member_id = claims["sub"]
        name      = claims.get("name") or member_id

        if room_id not in rooms:
            rooms[room_id]       = Room(room_id=room_id)
            connections[room_id] = {}

        room     = rooms[room_id]
        is_chair = len(room.members) == 0
        room.members.append(Member(id=member_id, name=name, is_chair=is_chair))
        connections[room_id][member_id] = websocket

        await websocket.send_text(json.dumps({"type": "welcome", "self_id": member_id}))
        await _broadcast_state(room_id)

        async for raw in websocket.iter_text():
            try:
                await _handle_message(room_id, member_id, websocket, json.loads(raw))
            except Exception as e:
                await _send_error(websocket, str(e))

    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        if member_id:
            await _handle_leave(room_id, member_id)
```

- [ ] **Step 4: Run all server tests**

```bash
cd signaling && pytest test_server.py -v
```

Expected: all tests PASS

- [ ] **Step 5: Start server and verify it accepts connections**

```bash
cd signaling && uvicorn server:app --port 8765 &
sleep 2
python3 -c "
import asyncio, websockets, json, time, jwt

token = jwt.encode({'sub':'u1','name':'Test','iss':'my-thin-bridge',
    'aud':'my-attached-app','exp':int(time.time())+3600},
    'change-me', algorithm='HS256')

async def test():
    async with websockets.connect('ws://localhost:8765/ws/testroom') as ws:
        await ws.send(json.dumps({'type':'join','token':token,'room_id':'testroom'}))
        welcome = json.loads(await ws.recv())
        assert welcome['type'] == 'welcome'
        state = json.loads(await ws.recv())
        assert state['type'] == 'state'
        print('Server OK — welcome:', welcome, 'phase:', state['state']['phase'])

asyncio.run(test())
"
kill %1 2>/dev/null
```

Expected: `Server OK — welcome: {'type': 'welcome', 'self_id': 'u1'} phase: open`

- [ ] **Step 6: Commit**

```bash
git add signaling/
git commit -m "feat: add signaling server with Roberts Rules state machine"
```

---

## Chunk 2: Frontend core

### Task 6: `webrtc/scripts/config.js`

**Files:**
- Create: `webrtc/scripts/config.js`

- [ ] **Step 1: Create the file**

```javascript
// webrtc/scripts/config.js
// Override WS_URL for production deployment.
export const WS_URL = 'ws://localhost:8765';

export const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
];
```

- [ ] **Step 2: Commit**

```bash
git add webrtc/scripts/config.js
git commit -m "feat: add webrtc config module"
```

---

### Task 7: `webrtc/scripts/signaling.js`

**Files:**
- Create: `webrtc/scripts/signaling.js`

- [ ] **Step 1: Create the file**

```javascript
// webrtc/scripts/signaling.js
// Manages the WebSocket connection to the signaling server.
// Dispatches CustomEvents: 'welcome', 'state', 'signal', 'error'
import { WS_URL } from './config.js';

export class SignalingClient extends EventTarget {
    #ws = null;
    #token = null;
    #roomId = null;
    #reconnectDelay = 2000;

    connect(token, roomId) {
        this.#token  = token;
        this.#roomId = roomId;
        this.#open();
    }

    send(msg) {
        if (this.#ws?.readyState === WebSocket.OPEN) {
            this.#ws.send(JSON.stringify(msg));
        }
    }

    close() {
        this.#token = null;  // prevent reconnect loop before closing
        this.#ws?.close();
        this.#ws = null;
    }

    #open() {
        this.#ws = new WebSocket(`${WS_URL}/ws/${this.#roomId}`);

        this.#ws.onopen = () => {
            this.#ws.send(JSON.stringify({
                type: 'join',
                token: this.#token,
                room_id: this.#roomId,
            }));
        };

        this.#ws.onmessage = ({ data }) => {
            const msg = JSON.parse(data);
            this.dispatchEvent(new CustomEvent(msg.type, { detail: msg }));
        };

        this.#ws.onclose = () => {
            // Reconnect unless explicitly closed
            if (this.#token) {
                setTimeout(() => this.#open(), this.#reconnectDelay);
            }
        };

        this.#ws.onerror = () => {
            this.dispatchEvent(new CustomEvent('error', {
                detail: { message: 'WebSocket error' },
            }));
        };
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add webrtc/scripts/signaling.js
git commit -m "feat: add SignalingClient WebSocket module"
```

---

### Task 8: `webrtc/scripts/meeting.js`

**Files:**
- Create: `webrtc/scripts/meeting.js`

- [ ] **Step 1: Create the file**

```javascript
// webrtc/scripts/meeting.js
// Manages WebRTC peer connections and the video grid.
// Each peer is keyed by member_id (sub claim = signaling identity).
import { ICE_SERVERS } from './config.js';

export class MeetingClient {
    #selfId;
    #signaling;
    #peers  = new Map(); // member_id → RTCPeerConnection
    #localStream = null;

    constructor(signaling, selfId) {
        this.#signaling = signaling;
        this.#selfId    = selfId;
    }

    async init() {
        this.#localStream = await navigator.mediaDevices.getUserMedia({
            video: true, audio: true,
        });
        this.#getOrCreateTile(this.#selfId, true).srcObject = this.#localStream;
        return this.#localStream;
    }

    // Called when a new member joins (after we receive updated state).
    // Only the peer with the lexicographically-higher member_id sends the first
    // offer — this prevents WebRTC "glare" (both sides sending offers simultaneously).
    async connectTo(memberId) {
        if (memberId === this.#selfId || this.#peers.has(memberId)) return;
        if (this.#selfId < memberId) return;  // let the other side initiate
        const pc    = this.#createPc(memberId);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.#signaling.send({ type: 'offer', to: memberId, sdp: offer });
    }

    async handleSignal(from, signalType, data) {
        if (signalType === 'offer') {
            // Close any existing connection for this peer before handling a new offer
            // (can happen on reconnect — prevents orphaned RTCPeerConnections)
            this.removePeer(from);
            const pc = this.#createPc(from);
            await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this.#signaling.send({ type: 'answer', to: from, sdp: answer });
        } else if (signalType === 'answer') {
            await this.#peers.get(from)?.setRemoteDescription(
                new RTCSessionDescription(data.sdp));
        } else if (signalType === 'ice') {
            await this.#peers.get(from)?.addIceCandidate(
                new RTCIceCandidate(data.candidate));
        }
    }

    removePeer(memberId) {
        this.#peers.get(memberId)?.close();
        this.#peers.delete(memberId);
        document.getElementById(`video-${memberId}`)?.remove();
    }

    highlightSpeaker(memberId) {
        document.querySelectorAll('.video-tile').forEach(el =>
            el.classList.toggle('speaking', el.id === `video-${memberId}`));
    }

    #createPc(memberId) {
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        this.#peers.set(memberId, pc);

        this.#localStream?.getTracks().forEach(t =>
            pc.addTrack(t, this.#localStream));

        pc.onicecandidate = ({ candidate }) => {
            if (candidate) {
                this.#signaling.send({ type: 'ice', to: memberId, candidate });
            }
        };

        pc.ontrack = ({ streams }) => {
            this.#getOrCreateTile(memberId, false).srcObject = streams[0];
        };

        return pc;
    }

    #getOrCreateTile(memberId, muted) {
        const id  = `video-${memberId}`;
        let   el  = document.getElementById(id);
        if (!el) {
            el           = document.createElement('video');
            el.id        = id;
            el.className = 'video-tile';
            el.autoplay  = true;
            el.playsInline = true;
            if (muted) el.muted = true;
            document.getElementById('video-grid').appendChild(el);
        }
        return el;
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add webrtc/scripts/meeting.js
git commit -m "feat: add MeetingClient WebRTC peer connection module"
```

---

## Chunk 3: Roberts Rules UI + HTML + styles

### Task 9: `webrtc/scripts/roberts.js`

**Files:**
- Create: `webrtc/scripts/roberts.js`

- [ ] **Step 1: Create the file**

```javascript
// webrtc/scripts/roberts.js
// Renders Roberts Rules UI from server state snapshots.
// All display logic lives here; no state is derived outside this module.

export class RobertsUI {
    #signaling;
    #selfId;
    #state = null;

    constructor(signaling, selfId) {
        this.#signaling = signaling;
        this.#selfId    = selfId;
    }

    // Call once after DOM is ready.
    bindButtons() {
        this.#on('btn-raise-hand', 'click', () => {
            const inQueue = this.#state?.speaker_queue.includes(this.#selfId);
            this.#signaling.send({ type: inQueue ? 'lower_hand' : 'raise_hand' });
        });
        // Yield Floor: only shown to the current speaker during floor_held
        this.#on('btn-yield-floor', 'click', () =>
            this.#signaling.send({ type: 'yield_floor' }));
        this.#on('btn-second',    'click', () => this.#signaling.send({ type: 'second_motion' }));
        this.#on('btn-withdraw',  'click', () => this.#signaling.send({ type: 'withdraw_motion' }));
        this.#on('btn-call-vote', 'click', () => this.#signaling.send({ type: 'call_vote' }));
        ['yea', 'nay', 'abstain'].forEach(v =>
            this.#on(`btn-${v}`, 'click', () =>
                this.#signaling.send({ type: 'cast_vote', vote: v })));
        document.getElementById('motion-form')?.addEventListener('submit', e => {
            e.preventDefault();
            const inp = document.getElementById('motion-input');
            const txt = inp?.value.trim();
            if (txt) {
                this.#signaling.send({ type: 'make_motion', text: txt });
                inp.value = '';
            }
        });
    }

    // Apply a full state snapshot from the server.
    applyState(state) {
        this.#state = state;
        const me      = state.members.find(m => m.id === this.#selfId);
        const isChair = me?.is_chair ?? false;
        const inQueue = state.speaker_queue.includes(this.#selfId);
        const phase   = state.phase;
        const motion  = state.motion;

        // Header
        this.#text('phase-badge',    phase.replace(/_/g, ' '));
        this.#text('member-count',   `${state.members.length} member${state.members.length !== 1 ? 's' : ''}`);

        // Speaker + timer
        const speaker = state.members.find(m => m.id === state.current_speaker);
        this.#text('current-speaker', speaker ? `${speaker.name} has the floor` : '');
        this.#text('timer-display',   state.current_speaker ? this.#fmt(state.timer_remaining) : '');

        // Queue
        const queueEl = document.getElementById('speaker-queue');
        if (queueEl) {
            queueEl.innerHTML = state.speaker_queue.map((id, i) => {
                const m = state.members.find(m => m.id === id);
                return `<li>${i + 1}. ${m?.name ?? id}</li>`;
            }).join('');
        }

        // Raise/lower hand button
        const canHand = ['open', 'floor_held', 'seconded'].includes(phase);
        this.#show('btn-raise-hand',  canHand);
        this.#text('btn-raise-hand',  inQueue ? '✋ Lower Hand' : '✋ Raise Hand');

        // Yield floor button — only shown to the current speaker in floor_held
        const isSpeaker = state.current_speaker === this.#selfId;
        this.#show('btn-yield-floor', phase === 'floor_held' && isSpeaker);

        // Motion display
        this.#show('motion-section', !!motion);
        if (motion) {
            this.#text('motion-text',  `"${motion.text}"`);
            const mover = state.members.find(m => m.id === motion.moved_by);
            this.#text('motion-meta', `Moved by ${mover?.name ?? motion.moved_by}`);
        }

        // Motion action buttons
        this.#show('btn-second',    phase === 'motion_pending' && motion?.moved_by !== this.#selfId);
        this.#show('btn-withdraw',  ['motion_pending', 'seconded'].includes(phase) && motion?.moved_by === this.#selfId);
        this.#show('btn-call-vote', phase === 'seconded' && isChair);

        // Voting section
        this.#show('voting-section', phase === 'voting');
        if (phase === 'voting' && motion) {
            this.#text('vote-yea-count',     String(motion.votes.yea));
            this.#text('vote-nay-count',     String(motion.votes.nay));
            this.#text('vote-abstain-count', String(motion.votes.abstain));
            const hasVoted = motion.member_votes[this.#selfId] !== undefined;
            ['btn-yea', 'btn-nay', 'btn-abstain'].forEach(id => {
                const btn = document.getElementById(id);
                if (btn) btn.disabled = hasVoted;
            });
        }

        // Motion form
        this.#show('motion-form', ['open', 'floor_held', 'seconded'].includes(phase));

        // Vote result
        const showResult = phase === 'vote_closed' && motion?.result;
        this.#show('vote-result', showResult);
        if (showResult) {
            this.#text('vote-result', `Motion ${motion.result.toUpperCase()}`);
        }

        // Chair controls
        this.#show('chair-controls', isChair);
    }

    #fmt(s) {
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }

    #on(id, event, fn) {
        document.getElementById(id)?.addEventListener(event, fn);
    }

    #text(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    }

    #show(id, visible) {
        const el = document.getElementById(id);
        if (el) el.style.display = visible ? '' : 'none';
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add webrtc/scripts/roberts.js
git commit -m "feat: add RobertsUI state-driven rendering module"
```

---

### Task 10: `webrtc/styles.css`

**Files:**
- Create: `webrtc/styles.css`

- [ ] **Step 1: Create the file**

```css
/* webrtc/styles.css — Meeting room layout */
@import url('../peptalks/styles.css');

.meeting-layout {
    display: grid;
    grid-template-rows: auto 1fr auto;
    grid-template-columns: 1fr 280px;
    grid-template-areas:
        "header  header"
        "video   sidebar"
        "toolbar toolbar";
    height: 100vh;
    gap: 0;
    background: var(--bg);
}

/* Header */
.meeting-header {
    grid-area: header;
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.6rem 1rem;
    background: var(--surface);
    border-bottom: 1px solid var(--line);
}

#phase-badge {
    padding: 0.2rem 0.6rem;
    border-radius: 99px;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 0.8rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
}

/* Video grid */
#video-grid {
    grid-area: video;
    display: flex;
    flex-wrap: wrap;
    align-content: flex-start;
    gap: 0.5rem;
    padding: 0.75rem;
    overflow-y: auto;
    background: #0a0a0f;
}

.video-tile {
    width: 220px;
    aspect-ratio: 16 / 9;
    border-radius: 10px;
    background: #1a1a2e;
    object-fit: cover;
    transition: box-shadow 200ms;
}

.video-tile.speaking {
    box-shadow: 0 0 0 3px var(--accent), 0 0 20px rgba(106, 60, 181, 0.5);
    flex: 1 1 100%;
    width: 100%;
    max-height: 50vh;
}

/* Sidebar */
.meeting-sidebar {
    grid-area: sidebar;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.75rem;
    background: var(--surface);
    border-left: 1px solid var(--line);
    overflow-y: auto;
}

.speaker-info {
    text-align: center;
}

#current-speaker {
    font-weight: 600;
    font-size: 0.9rem;
    color: var(--text);
}

#timer-display {
    font-size: 2rem;
    font-weight: 700;
    color: var(--accent);
    font-variant-numeric: tabular-nums;
}

#speaker-queue {
    list-style: none;
    padding: 0;
    margin: 0;
    font-size: 0.85rem;
    color: var(--muted);
}

#speaker-queue li { padding: 0.2rem 0; }

/* Toolbar */
.meeting-toolbar {
    grid-area: toolbar;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 1rem;
    background: var(--surface);
    border-top: 1px solid var(--line);
}

#motion-section { display: flex; flex-direction: column; gap: 0.25rem; }
#motion-text    { font-style: italic; font-size: 0.9rem; }
#motion-meta    { font-size: 0.8rem; color: var(--muted); }

#voting-section {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
}

.vote-tally { font-size: 0.85rem; color: var(--muted); }

#vote-result {
    padding: 0.3rem 0.75rem;
    border-radius: 99px;
    font-weight: 700;
    background: var(--accent-soft);
    color: var(--accent);
}

#motion-form {
    display: flex;
    gap: 0.4rem;
    flex: 1;
    min-width: 200px;
}

#motion-input {
    flex: 1;
    padding: 0.4rem 0.75rem;
    border: 1px solid var(--line);
    border-radius: var(--radius);
    background: var(--bg);
    color: var(--text);
    font-size: 0.9rem;
}

/* Error banner */
#error-banner {
    position: fixed;
    top: 1rem; left: 50%;
    transform: translateX(-50%);
    background: #c0392b;
    color: white;
    padding: 0.5rem 1.25rem;
    border-radius: var(--radius);
    font-size: 0.9rem;
    z-index: 999;
}

@media (max-width: 720px) {
    .meeting-layout {
        grid-template-columns: 1fr;
        grid-template-areas: "header" "video" "sidebar" "toolbar";
        height: auto;
    }
    .video-tile { width: 100%; }
}
```

- [ ] **Step 2: Commit**

```bash
git add webrtc/styles.css
git commit -m "feat: add meeting room CSS"
```

---

### Task 11: `webrtc/index.html`

**Files:**
- Create: `webrtc/index.html`

- [ ] **Step 1: Create the file**

```html
<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Meeting Room — MD Forward Party</title>
    <meta name="description" content="Real-time Roberts Rules meeting room for Maryland Forward Party members." />
    <link rel="icon" type="image/png" href="../images/favicon.png" />
    <link rel="stylesheet" href="styles.css" />
</head>
<body>
<div id="error-banner" style="display:none;"></div>

<div class="meeting-layout">

    <!-- Header -->
    <header class="meeting-header">
        <a href="../index.html" style="font-weight:700;color:var(--accent);text-decoration:none;">← FWD App</a>
        <span id="room-name" style="font-weight:600;"></span>
        <span id="phase-badge">open</span>
        <span id="member-count" style="margin-left:auto;font-size:0.85rem;color:var(--muted);"></span>
    </header>

    <!-- Video grid -->
    <section aria-label="Video grid" id="video-grid"></section>

    <!-- Sidebar: speaker info + queue -->
    <aside class="meeting-sidebar">
        <div class="speaker-info">
            <div id="current-speaker"></div>
            <div id="timer-display"></div>
        </div>

        <div>
            <strong style="font-size:0.8rem;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;">Speaker Queue</strong>
            <ol id="speaker-queue"></ol>
        </div>

        <button id="btn-raise-hand"   class="btn" style="display:none;">✋ Raise Hand</button>
        <button id="btn-yield-floor" class="btn" style="display:none;">⏭ Yield Floor</button>

        <!-- Chair controls -->
        <div id="chair-controls" style="display:none;">
            <label style="font-size:0.8rem;color:var(--muted);">
                Speaker time (s)
                <input id="speaker-time-input" type="number" min="10" max="600" value="60"
                    style="width:60px;margin-left:.4rem;" />
            </label>
            <button id="btn-set-time" class="btn btn-small">Set</button>
        </div>
    </aside>

    <!-- Bottom toolbar -->
    <div class="meeting-toolbar" role="toolbar" aria-label="Meeting controls">

        <!-- Active motion display -->
        <div id="motion-section" style="display:none;">
            <div id="motion-text"></div>
            <div id="motion-meta"></div>
        </div>

        <button id="btn-second"    class="btn" style="display:none;">Second Motion</button>
        <button id="btn-withdraw"  class="btn" style="display:none;">Withdraw</button>
        <button id="btn-call-vote" class="btn" style="display:none;">Call Vote</button>

        <!-- Voting -->
        <div id="voting-section" style="display:none;">
            <button id="btn-yea"     class="btn">✅ Yea</button>
            <button id="btn-nay"     class="btn">❌ Nay</button>
            <button id="btn-abstain" class="btn">⬜ Abstain</button>
            <span class="vote-tally">
                Yea: <strong id="vote-yea-count">0</strong>
                Nay: <strong id="vote-nay-count">0</strong>
                Abs: <strong id="vote-abstain-count">0</strong>
            </span>
        </div>

        <span id="vote-result" style="display:none;"></span>

        <!-- Make motion form -->
        <form id="motion-form" style="display:none;" aria-label="Make a motion">
            <input id="motion-input" type="text" placeholder="I move to…"
                   aria-label="Motion text" maxlength="200" />
            <button class="btn" type="submit">Move</button>
        </form>
    </div>

</div><!-- .meeting-layout -->

<script type="module">
import { SignalingClient } from './scripts/signaling.js';
import { MeetingClient }   from './scripts/meeting.js';
import { RobertsUI }       from './scripts/roberts.js';

// TOKEN_KEY matches the value exported by scripts/config.js (best practices cleanup plan)
// Inlined here to keep this module self-contained without a cross-directory import.
const TOKEN_KEY = 'wix_member_token';

// ── Auth gate ────────────────────────────────────────────────────────────────
const token = localStorage.getItem(TOKEN_KEY);
if (!token) {
    window.location.href = '../index.html';
}

// ── Room ID from URL or default ──────────────────────────────────────────────
const roomId = new URLSearchParams(window.location.search).get('room') || 'main';
document.getElementById('room-name').textContent = `Room: ${roomId}`;

// ── Wire up modules ──────────────────────────────────────────────────────────
const signaling = new SignalingClient();
let meeting, roberts, selfId;
let initialized = false;  // guard against re-init on reconnect

signaling.addEventListener('welcome', async ({ detail }) => {
    if (initialized) return;  // reconnect sends welcome again — skip re-init
    initialized = true;
    selfId  = detail.self_id;
    meeting = new MeetingClient(signaling, selfId);
    roberts = new RobertsUI(signaling, selfId);
    roberts.bindButtons();

    // Chair: set speaker time button
    document.getElementById('btn-set-time')?.addEventListener('click', () => {
        const secs = parseInt(document.getElementById('speaker-time-input').value);
        signaling.send({ type: 'set_speaker_time', seconds: secs });
    });

    try {
        await meeting.init();
    } catch (e) {
        showError('Camera/mic access denied — audio/video unavailable.');
    }
});

let prevMemberIds = new Set();

signaling.addEventListener('state', async ({ detail }) => {
    const state = detail.state;
    if (!roberts || !meeting) return;

    roberts.applyState(state);
    meeting.highlightSpeaker(state.current_speaker);

    // Remove peers who left since last state update
    const currentIds = new Set(state.members.map(m => m.id));
    for (const id of prevMemberIds) {
        if (!currentIds.has(id) && id !== selfId) {
            meeting.removePeer(id);
        }
    }
    prevMemberIds = currentIds;

    // Connect to any new peers
    for (const m of state.members) {
        if (m.id !== selfId) await meeting.connectTo(m.id);
    }
});

signaling.addEventListener('signal', async ({ detail }) => {
    await meeting?.handleSignal(detail.from, detail.signal_type, detail);
});

signaling.addEventListener('error', ({ detail }) => {
    showError(detail.message);
});

function showError(msg) {
    const el = document.getElementById('error-banner');
    el.textContent = msg;
    el.style.display = '';
    setTimeout(() => { el.style.display = 'none'; }, 5000);
}

signaling.connect(token, roomId);
</script>
</body>
</html>
```

- [ ] **Step 2: Verify the file exists**

```bash
cat webrtc/index.html | grep '<title>'
```

Expected: `<title>Meeting Room — MD Forward Party</title>`

- [ ] **Step 3: Commit**

```bash
git add webrtc/
git commit -m "feat: add WebRTC Roberts Rules meeting room frontend"
```

---

### Task 12: End-to-end smoke test

- [ ] **Step 1: Start signaling server**

```bash
cd signaling && APP_JWT_SECRET=change-me uvicorn server:app --port 8765 &
```

- [ ] **Step 2: Serve static files**

```bash
cd /Applications/Julian/fwdapp && python3 -m http.server 8080 &
```

- [ ] **Step 3: Open meeting room in two browser tabs**

Visit `http://localhost:8080/webrtc/index.html?room=test` in two separate tabs (you'll need a valid app JWT in `localStorage.wix_member_token` — paste one from the main page auth flow, or set a test value with the helper below).

To generate and set a test token, run this in the terminal and paste the output into both browser consoles:

```bash
python3 -c "
import jwt, time
token = jwt.encode(
    {'sub': 'user1', 'name': 'Alice', 'iss': 'my-thin-bridge',
     'aud': 'my-attached-app', 'exp': int(time.time()) + 3600},
    'change-me', algorithm='HS256')
print('localStorage.setItem(\"wix_member_token\", \"' + token + '\")')
"
```

Paste the printed `localStorage.setItem(...)` line into Tab 1's browser console and press Enter.
For Tab 2, generate a second token with `'sub': 'user2', 'name': 'Bob'` and set it the same way.

- [ ] **Step 4: Verify Roberts Rules flow**

In Tab 1 (Alice, chair):
1. Click **✋ Raise Hand** — queue shows your name; floor auto-granted
2. Timer counts down from 1:00
3. Click **⏭ Yield Floor** — floor releases immediately; Tab 1 returns to `open`

In Tab 2 (Bob):
1. Raise hand before Tab 1 yields — appears in queue
2. After Tab 1 yields, Bob auto-gets the floor and his timer starts

Motion flow (Tab 1, after getting floor):
1. Type "I move to adjourn" → click **Move**
2. Tab 2 sees **Second Motion** button → click it
3. Chair (Tab 1) sees **Call Vote** → click
4. Both tabs vote → result appears for 5 seconds

- [ ] **Step 5: Kill background servers**

```bash
kill %1 %2 2>/dev/null
```

- [ ] **Step 6: Final commit**

```bash
git add -A
git status
git commit -m "feat: WebRTC Roberts Rules meeting room complete"
```
