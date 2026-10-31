// Single-microphone transport selection: realtime when configured and healthy,
// REST otherwise. A realtime failure sticks for the session (no flapping back
// and forth); reloading re-enables realtime. Draft, review, and approval
// boundaries are untouched: both transports feed the same receive() path, so
// switching never duplicates or drops a recipe operation.
export type VoiceTransport = "realtime" | "rest";
export function resolveTransport(configured: boolean, realtimeFailed: boolean): VoiceTransport {
  return configured && !realtimeFailed ? "realtime" : "rest";
}
// Only a terminal realtime failure ("failed") falls back. A user stop
// ("closed") or a healthy session keeps the configured transport, so the next
// microphone press retries realtime instead of silently downgrading.
export function isTerminalRealtimeFailure(state: string): boolean {
  return state === "failed";
}
