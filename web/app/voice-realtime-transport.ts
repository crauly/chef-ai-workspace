// Phase B realtime transport: browser WS to the Python relay, then Meta.
// No API keys here; the browser presents only a single-use ticket.
// The socket factory is injectable so fixture tests run without a microphone.
//
// Turn contract (SSOT: VoiceTurnStore):
// - transcript events are provisional display info only, even with final:true.
// - speechComplete is the sole committed transcript, once per turnId, and
//   its body is the canonical text.
// - speechEnd is a boundary signal only; it never commits, never fabricates.
import {VoiceTurnStore} from "./voice-turn-store";
import {
  REALTIME_BACKLOG_BYTES,
  REALTIME_REFRESH_MS,
  REALTIME_SESSION_LIMIT_MS,
} from "./voice-realtime-audio";

export type RealtimeState = "idle" | "connecting" | "ready" | "closed" | "failed";
export type RealtimeCallbacks = {
  onCommitted?: (text: string, turnId: string) => void;
  onPartial?: (text: string, turnId: string) => void;
  onState?: (state: RealtimeState, reason: string) => void;
};
export type SocketLike = {
  send(data: string | ArrayBuffer): void;
  close(code?: number): void;
  onmessage: ((ev: {data: unknown}) => void) | null;
  onclose: ((ev: {code: number}) => void) | null;
  onerror: (() => void) | null;
};

export {REALTIME_BACKLOG_BYTES, REALTIME_REFRESH_MS, REALTIME_SESSION_LIMIT_MS};

export function backlogExceeded(pendingBytes: number): boolean {
  return pendingBytes > REALTIME_BACKLOG_BYTES;
}

export class RealtimeTransport {
  private socket: SocketLike | null = null;
  private state: RealtimeState = "idle";
  constructor(
    private openSocket: (url: string) => SocketLike,
    private callbacks: RealtimeCallbacks = {},
    readonly turns: VoiceTurnStore = new VoiceTurnStore(),
  ) {}

  connect(url: string, ticket: string): void {
    this.setState("connecting", "opening relay");
    const socket = this.openSocket(url);
    this.socket = socket;
    socket.onclose = () => this.setState("closed", "relay closed");
    socket.onerror = () => this.setState("failed", "relay error");
    socket.onmessage = ev => this.onFrame(ev.data);
    socket.send(JSON.stringify({ticket}));
  }

  sendPcm(chunk: ArrayBuffer, pendingBytes: number): boolean {
    if (!this.socket || this.state !== "ready") return false;
    if (backlogExceeded(pendingBytes)) return false; // never exceed 5s backlog
    this.socket.send(chunk);
    return true;
  }

  finish(): void {
    try { this.socket?.send(JSON.stringify({type: "endStream"})); } catch { /* ignore */ }
  }

  close(code?: number): void {
    try { this.socket?.close(code); } catch { /* ignore */ }
    this.setState("closed", "explicit stop");
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
    if (type === "ready") { this.setState("ready", "relay ready"); return; }
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
