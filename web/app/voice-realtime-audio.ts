// Phase B realtime audio helpers. Pure and dependency-free: no React,
// no microphone, no network. Usable from hooks and fixture tests.
export const REALTIME_SAMPLE_RATE = 24000;
/** Bytes of 16-bit mono PCM per second at the realtime rate. */
export const REALTIME_BYTES_PER_SECOND = REALTIME_SAMPLE_RATE * 2;
/** Unsent PCM beyond this is dropped oldest-first; the draft is never touched. */
export const REALTIME_BACKLOG_BYTES = 5 * REALTIME_BYTES_PER_SECOND;
/** Pacing quantum for the sender timer. */
export const REALTIME_SEND_INTERVAL_MS = 100;
/** Max samples emitted per pacing quantum (real-time pace). */
export const REALTIME_MAX_SEND_SAMPLES = REALTIME_SAMPLE_RATE / 10;
/** Proactive session refresh before Meta's 60-minute limit. */
export const REALTIME_REFRESH_MS = 55 * 60 * 1000;
/** Meta's default realtime session limit. */
export const REALTIME_SESSION_LIMIT_MS = 60 * 60 * 1000;

/** Linear-resample one device-rate mono frame to 24kHz signed 16-bit PCM. */
export function resampleTo24kMono(frame: Float32Array, inRate: number): Int16Array {
  if (!Number.isFinite(inRate) || inRate <= 0) return new Int16Array(0);
  const out = new Int16Array(Math.max(0, Math.ceil(frame.length * REALTIME_SAMPLE_RATE / inRate)));
  for (let i = 0; i < out.length; i++) {
    const pos = i * inRate / REALTIME_SAMPLE_RATE;
    const lo = Math.floor(pos), hi = Math.min(frame.length - 1, lo + 1);
    const sample = frame[lo] + (frame[hi] - frame[lo]) * (pos - lo);
    const clamped = Math.max(-1, Math.min(1, sample));
    out[i] = Math.round(clamped * (clamped < 0 ? 32768 : 32767));
  }
  return out;
}

/**
 * Relay WebSocket endpoint. The base is a public origin (wss://...), never a
 * secret. Null when unconfigured: realtime is then unavailable and the caller
 * must fall back to REST, keeping the draft.
 */
export function realtimeWsEndpoint(): string | null {
  const base = process.env.NEXT_PUBLIC_DEMO_WS_URL ?? "";
  if (!base.trim()) return null;
  return base.replace(/\/$/, "") + "/demo/voice-realtime";
}
