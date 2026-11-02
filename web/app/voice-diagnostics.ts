"use client";
// Lightweight in-memory voice diagnostics. No persistence, no audio,
// no API keys, no full utterance text. A short trace id assigned at
// utterance intake links transcription intake, Muse processing, draft
// updates, and mode transitions that belong to the same utterance.
export type VoiceDiagKind =
  | "capture.start" | "capture.stop" | "capture.pause" | "capture.resume"
  | "capture.backlog" | "capture.backlog.drop"
  | "capture.disconnect" | "capture.error"
  | "capture.endpoint.deferred" | "capture.endpoint.forced"
  | "transcribe.ok" | "transcribe.nospeech" | "transcribe.fail"
  | "muse.start" | "muse.ok" | "muse.fail"
  | "photo.start" | "photo.fail"
  | "dish-image.start" | "dish-image.ok" | "dish-image.fail" | "dish-image.persisted" | "dish-image.persist.fail"
  | "price.start" | "price.ok" | "price.fail"
  | "mode.transition" | "mode.transition.rejected"
  | "draft.created" | "draft.updated" | "draft.kept" | "draft.discarded.explicit"
  | "intent.fallback" | "queue.dropped";
export type VoiceDiagEvent = {seq:number;at:number;kind:VoiceDiagKind;detail:string;trace:string};
const MAX_EVENTS = 60;
let seq = 0;
const events: VoiceDiagEvent[] = [];
const listeners = new Set<() => void>();
function emit() { listeners.forEach(notify => { try { notify(); } catch { /* ignore */ } }); }
export function logVoiceEvent(kind:VoiceDiagKind, detail = "", traceId = ""): VoiceDiagEvent {
  // Keep only a short label; never log audio, keys, or full spoken text.
  const short = detail.length > 80 ? detail.slice(0, 80) + "…" : detail;
  const event = {seq: ++seq, at: Date.now(), kind, detail: short, trace: traceId.slice(-8)};
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
