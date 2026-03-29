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
