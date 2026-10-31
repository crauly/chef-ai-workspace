// Phase B realtime transport: browser WS to the Python relay, then Meta.
// No API keys here; the browser presents only a single-use ticket.
// The socket factory is injectable so fixture tests run without a microphone.
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

export const REALTIME_BACKLOG_BYTES = 5 * 24000 * 2; // 5s of 16-bit mono 24kHz PCM
export const REALTIME_SESSION_LIMIT_MS = 60 * 60 * 1000;

export function backlogExceeded(pendingBytes: number): boolean {
  return pendingBytes > REALTIME_BACKLOG_BYTES;
}

export class RealtimeTransport {
  private socket: SocketLike | null = null;
  private state: RealtimeState = "idle";
  private seen = new Set<string>();
  private lastOpen: string | null = null;
  constructor(
    private openSocket: (url: string) => SocketLike,
    private callbacks: RealtimeCallbacks = {},
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
      this.lastOpen = event["turnId"];
      return;
    }
    if (type === "transcript") {
      const text = typeof event["transcript"] === "string" ? event["transcript"] : "";
      const final = event["final"] === true;
      const turnId = typeof event["turnId"] === "string" ? event["turnId"] : this.lastOpen;
      if (!turnId || !text.trim()) return;
      if (final) {
        if (this.seen.has(turnId)) return; // duplicate speechComplete
        this.seen.add(turnId);
        try { this.callbacks.onCommitted?.(text, turnId); } catch { /* ignore */ }
      } else {
        try { this.callbacks.onPartial?.(text, turnId); } catch { /* ignore */ }
      }
      return;
    }
    if (type === "speechComplete") {
      const turnId = typeof event["turnId"] === "string" ? event["turnId"] : this.lastOpen;
      const text = typeof event["transcript"] === "string" ? event["transcript"] : "";
      if (!turnId || !text.trim() || this.seen.has(turnId)) return;
      this.seen.add(turnId);
      try { this.callbacks.onCommitted?.(text, turnId); } catch { /* ignore */ }
    }
    // speechEnd is a boundary-only signal: never commits, never fabricates.
  }
}
