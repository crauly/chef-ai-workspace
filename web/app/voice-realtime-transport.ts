// Phase B realtime transport: browser WS to the Python relay, then Meta.
// No API keys here; the browser presents only a single-use ticket.
// The socket factory is injectable so fixture tests run without a microphone.
//
// Connection contract:
// - The ticket is sent only after the socket opens. A close, error, or
//   explicit cancel before open sends nothing and never becomes ready.
// - Stopping is a two-phase drain: endStream first, then the socket closes
//   after the relay answers (or after a finite timeout). The final
//   speechComplete still commits through the shared store exactly once.
//
// Turn contract (SSOT: VoiceTurnStore):
// - transcript events are provisional display info only, even with final:true.
// - speechComplete is the sole committed transcript, once per turnId, and
//   its body is the canonical text.
// - speechEnd is a boundary signal only; it never commits, never fabricates.
import {VoiceTurnStore} from "./voice-turn-store";
import {
  REALTIME_BACKLOG_BYTES,
  REALTIME_DRAIN_TIMEOUT_MS,
  REALTIME_REFRESH_MS,
  REALTIME_SESSION_LIMIT_MS,
} from "./voice-realtime-audio";

export type RealtimeState = "idle" | "connecting" | "ready" | "draining" | "closed" | "failed";
export type RealtimeCallbacks = {
  onCommitted?: (text: string, turnId: string) => void;
  onPartial?: (text: string, turnId: string) => void;
  onState?: (state: RealtimeState, reason: string) => void;
};
export type SocketLike = {
  send(data: string | ArrayBuffer): void;
  close(code?: number): void;
  onopen: (() => void) | null;
  onmessage: ((ev: {data: unknown}) => void) | null;
  onclose: ((ev: {code: number}) => void) | null;
  onerror: (() => void) | null;
};

export {
  REALTIME_BACKLOG_BYTES,
  REALTIME_DRAIN_TIMEOUT_MS,
  REALTIME_REFRESH_MS,
  REALTIME_SESSION_LIMIT_MS,
};

export function backlogExceeded(pendingBytes: number): boolean {
  return pendingBytes > REALTIME_BACKLOG_BYTES;
}

export class RealtimeTransport {
  private socket: SocketLike | null = null;
  private state: RealtimeState = "idle";
  private epoch = 0;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private openSocket: (url: string) => SocketLike,
    private callbacks: RealtimeCallbacks = {},
    readonly turns: VoiceTurnStore = new VoiceTurnStore(),
  ) {}

  connect(url: string, ticket: string): void {
    this.cancelPending("reconnecting");
    const my = ++this.epoch;
    this.setState("connecting", "opening relay");
    const socket = this.openSocket(url);
    this.socket = socket;
    socket.onopen = () => {
      if (my !== this.epoch || this.socket !== socket) return;
      try {
        socket.send(JSON.stringify({ticket}));
      } catch {
        if (my === this.epoch) this.setState("failed", "ticket send failed");
      }
    };
    socket.onclose = () => {
      if (my !== this.epoch || this.socket !== socket) return;
      // A closed socket is never reused: late open/message frames are dead.
      this.detachSocket();
      this.setState("closed", "relay closed");
    };
    socket.onerror = () => {
      if (my !== this.epoch || this.socket !== socket) return;
      this.detachSocket();
      this.setState("failed", "relay error");
    };
    socket.onmessage = ev => {
      if (my !== this.epoch || this.socket !== socket) return;
      this.onFrame(ev.data);
    };
  }

  sendPcm(chunk: ArrayBuffer, pendingBytes: number): boolean {
    if (!this.socket || this.state !== "ready") return false;
    if (backlogExceeded(pendingBytes)) return false; // never exceed 5s backlog
    this.socket.send(chunk);
    return true;
  }

  /** Signal end of audio without closing: used by the refresh path. */
  finish(): void {
    try { this.socket?.send(JSON.stringify({type: "endStream"})); } catch { /* ignore */ }
  }

  /**
   * User stop: end audio, then wait for the relay to answer with the final
   * speechComplete (or a finite timeout) before closing. Late duplicates
   * are absorbed by the shared turn store; a timeout or cut keeps the draft.
   */
  finishAndDrain(timeoutMs: number = REALTIME_DRAIN_TIMEOUT_MS): void {
    if (this.state !== "ready") { this.close(); return; }
    try {
      this.socket?.send(JSON.stringify({type: "endStream"}));
    } catch {
      this.close();
      return;
    }
    this.setState("draining", "waiting for final transcript");
    if (this.drainTimer) clearTimeout(this.drainTimer);
    const my = this.epoch;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      if (my !== this.epoch) return;
      this.close();
    }, Math.max(0, timeoutMs));
  }

  close(code?: number): void {
    this.cancelPending("explicit stop");
    this.setState("closed", "explicit stop");
  }

  private detachSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
    }
  }

  private cancelPending(_reason: string): void {
    this.epoch++;
    if (this.drainTimer) { clearTimeout(this.drainTimer); this.drainTimer = null; }
    const socket = this.socket;
    this.detachSocket();
    if (socket) {
      try { socket.close(); } catch { /* ignore */ }
    }
    void _reason;
  }

  private setState(state: RealtimeState, reason: string): void {
    this.state = state;
    try { this.callbacks.onState?.(state, reason); } catch { /* ignore */ }
  }

  private onFrame(data: unknown): void {
    if (typeof data !== "string") return; // PCM never flows downstream
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!parsed || typeof parsed !== "object") return;
      event = parsed as Record<string, unknown>;
    } catch { return; }
    const type = event["type"];
    // Ready is meaningful only while connecting. Past that point (ready,
    // draining, closed, failed) a stray ready must not resurrect the state;
    // late turn events still flow to the store during the drain.
    if (type === "ready") {
      if (this.state !== "connecting") return;
      this.setState("ready", "relay ready");
      return;
    }
    if (type === "error") { this.setState("failed", String(event["reason"] ?? "upstream")); return; }
    if (type === "speechStart" && typeof event["turnId"] === "string") {
      this.turns.handle({type: "speechStart", turnId: event["turnId"]});
      return;
    }
    if (type === "speechEnd" && typeof event["turnId"] === "string") {
      this.turns.handle({type: "speechEnd", turnId: event["turnId"]});
      return;
    }
    if (type === "transcript") {
      // Provisional even when final:true. Never commits; never reaches Muse.
      const text = typeof event["transcript"] === "string" ? event["transcript"] : "";
      if (!text.trim()) return;
      this.turns.handle({type: "partial", text});
      const open = this.turns.openTurns();
      if (!open.length) return; // stray partial with no open turn: drop it
      try { this.callbacks.onPartial?.(text, open[open.length - 1]); } catch { /* ignore */ }
      return;
    }
    if (type === "speechComplete") {
      const turnId = typeof event["turnId"] === "string" ? event["turnId"] : "";
      const text = typeof event["transcript"] === "string" ? event["transcript"] : "";
      if (!turnId || !text.trim()) return;
      const fresh = this.turns.handle({type: "speechComplete", turnId, text});
      if (!fresh.length) return; // duplicate delivery
      try { this.callbacks.onCommitted?.(fresh[0].text, fresh[0].turnId); } catch { /* ignore */ }
    }
  }
}
