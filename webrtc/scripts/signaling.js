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
