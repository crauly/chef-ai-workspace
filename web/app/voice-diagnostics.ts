"use client";
// Lightweight in-memory voice diagnostics. No persistence, no audio,
// no API keys, no full utterance text. Correlates capture, transcription,
// Muse processing, mode transitions, and draft retention in one trail.
export type VoiceDiagKind =
  | "capture.start" | "capture.stop" | "capture.pause" | "capture.resume"
  | "capture.disconnect" | "capture.error"
  | "transcribe.ok" | "transcribe.fail"
  | "muse.start" | "muse.ok" | "muse.fail"
  | "mode.transition" | "mode.transition.rejected"
  | "draft.created" | "draft.updated" | "draft.kept" | "draft.discarded.explicit"
  | "intent.fallback" | "queue.dropped";
export type VoiceDiagEvent = {seq:number;at:number;kind:VoiceDiagKind;detail:string};
const MAX_EVENTS = 60;
let seq = 0;
const events: VoiceDiagEvent[] = [];
const listeners = new Set<() => void>();
function emit() { listeners.forEach(notify => { try { notify(); } catch { /* ignore */ } }); }
export function logVoiceEvent(kind:VoiceDiagKind, detail = ""): VoiceDiagEvent {
  // Keep only a short label; never log audio, keys, or full spoken text.
  const short = detail.length > 80 ? detail.slice(0, 80) + "…" : detail;
  const event = {seq: ++seq, at: Date.now(), kind, detail: short};
  events.push(event);
  while (events.length > MAX_EVENTS) events.shift();
  emit();
  return event;
}
export function getVoiceEvents(): VoiceDiagEvent[] { return [...events]; }
export function subscribeVoiceEvents(notify: () => void): () => void {
  listeners.add(notify);
  return () => { listeners.delete(notify); };
}
