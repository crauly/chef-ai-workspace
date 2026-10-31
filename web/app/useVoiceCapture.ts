"use client";
import {useEffect, useRef, useState} from "react";
import type {Locale} from "./i18n";
import {logVoiceEvent} from "./voice-diagnostics";

// One microphone across all entry points. Never run overlapping voice sessions.
// Both the REST batch hook and the realtime hook arbitrate through these
// helpers: starting one input stops the other, and neither discards a draft.
let releaseMicrophone: (() => void) | undefined;
export function takeMicrophone(releaser: () => void): void {
  releaseMicrophone?.();
  releaseMicrophone = releaser;
}
export function yieldMicrophone(releaser: () => void): void {
  if (releaseMicrophone === releaser) releaseMicrophone = undefined;
}
export const VOICE_SILENCE_MS = 1000;
// traceId is assigned at utterance intake and forwarded through submit/enqueue.
export type VoiceCaptureMeta = {reviewEpoch: number; traceId?: string};

export async function encodeWav(frames: Float32Array[], rate: number): Promise<ArrayBuffer> {
  const length = frames.reduce((n, frame) => n + frame.length, 0);
  const offline = new OfflineAudioContext(1, Math.ceil(length * 24_000 / rate), 24_000);
  const buffer = offline.createBuffer(1, length, rate);
  let offset = 0;
  for (const frame of frames) {buffer.getChannelData(0).set(frame, offset); offset += frame.length;}
  const source = offline.createBufferSource(); source.buffer = buffer;
  source.connect(offline.destination); source.start();
  const samples = (await offline.startRendering()).getChannelData(0);
  const wav = new ArrayBuffer(44 + samples.length * 2), v = new DataView(wav);
  const tag = (at: number, text: string) => [...text].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  tag(0, "RIFF"); v.setUint32(4, wav.byteLength - 8, true); tag(8, "WAVE"); tag(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 24_000, true); v.setUint32(28, 48_000, true); v.setUint16(32, 2, true);
  v.setUint16(34, 16, true); tag(36, "data"); v.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, s)) * (s < 0 ? 32768 : 32767)), true));
  return wav;
}

export function useVoiceCapture(locale: Locale, onTranscript: (text: string, meta?: VoiceCaptureMeta) => void, continuous = false) {
  const [recording, setRecording] = useState(false), [busy, setBusy] = useState(false);
  const [supported, setSupported] = useState<boolean | null>(null), [error, setError] = useState("");
  const [notice,setNotice]=useState("");
  const callback = useRef(onTranscript); callback.current = onTranscript;
  const controls = useRef<{stop: () => void; abort: () => void; markReview: (epoch:number) => void} | null>(null);
  const reviewEpoch = useRef(0);
  const generation = useRef(0), mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    setSupported(typeof navigator.mediaDevices?.getUserMedia === "function" &&
      typeof window.AudioContext === "function" && typeof window.AudioWorkletNode === "function" &&
      typeof window.OfflineAudioContext === "function");
    return () => {mounted.current = false; controls.current?.abort();};
  }, []);
  function cancel() {controls.current?.abort();}
  function stop() {controls.current?.stop();}
  function markReview() {const epoch=++reviewEpoch.current;controls.current?.markReview(epoch);return epoch;}
  async function start() {
    if (controls.current) return;
    releaseMicrophone?.();
    const token = ++generation.current;
    const valid = () => mounted.current && generation.current === token;
    let stream: MediaStream | undefined, context: AudioContext | undefined, node: AudioWorkletNode | undefined;
    let frames: Float32Array[] = [], samples = 0, silent = 0, voiced = false;
    let speechReviewEpoch = 0;
    let pending = Promise.resolve(), requests = 0, closed = false;
    // Accepted audio waiting for a free transcription slot. Bounded so a
    // slow network cannot grow memory without bound; oldest spills first.
    let backlog: {frames: Float32Array[]; rate: number; review: number}[] = [];
    let backlogSamples = 0;
    const BACKLOG_MAX_SAMPLES = 24_000 * 60;
    const aborter = new AbortController();
    const cleanup = () => {
      if(closed)return;
      closed = true; stream?.getTracks().forEach(track => track.stop());
      if (node) {node.port.onmessage = null; node.disconnect();}
      if (context && context.state !== "closed") void context.close();
      if (valid()) setRecording(false);
      if (!requests) yieldMicrophone(abort);
    };
    const abort = () => {
      cleanup(); aborter.abort(); ++generation.current; controls.current = null;
      yieldMicrophone(abort);
      if (mounted.current) {setRecording(false); setBusy(false);}
    };
    const batchSamples = (batch: Float32Array[]) => batch.reduce((n, frame) => n + frame.length, 0);
    const refreshBacklogNotice = () => {
      if (!mounted.current) return;
      if (backlog.length)
        setNotice(locale === "ja" ? `受信済みの音声${backlog.length}件を順に文字にしています。話し続けられます。下書きは保持しています。` : `Transcribing ${backlog.length} buffered utterance(s). Keep talking; the draft is retained.`);
      else setNotice("");
    };
    const runBatch = (batch: Float32Array[], rate: number, capturedReview: number) => {
      // Keep accepted audio. Capture never stops for a transcription failure:
      // the microphone stays open, the draft stays, and the failure is shown.
      requests++; setBusy(true);
      pending = pending.then(async () => {
        if (!valid()) return;
        const wav = await encodeWav(batch, rate);
        if (!valid()) return;
        const response = await fetch("/api/voice/transcribe", {method: "POST",
          headers: {"Content-Type": "audio/wav", "X-Audio-Language": locale}, body: wav,
          signal: AbortSignal.any([aborter.signal, AbortSignal.timeout(35_000)])});
        if (!response.ok) {
          let code = "";
          try {code = String((await response.json() as {code?: unknown}).code ?? "");} catch {code = "";}
          throw new Error("transcription:" + (code || response.status));
        }
        const result: unknown = await response.json();
        const text = result && typeof result === "object" ? (result as {transcript?: unknown}).transcript : null;
        if (typeof text !== "string" || !text.trim() || text.length > 1000) throw new Error("transcription:invalid");
        logVoiceEvent("transcribe.ok", "");
        if (valid()) callback.current(text, {reviewEpoch:capturedReview});
      }).catch((error: unknown) => {
        const code = error instanceof Error ? error.message : "";
        const timedOut = code.includes("provider_timeout") || code.includes("504");
        logVoiceEvent("transcribe.fail", code || "transcription request failed");
        if (valid()) {
          // A user stop still flushes accepted audio; only then is the
          // microphone already closed. Otherwise recording continues and
          // only the failed fragment needs repeating.
          const stopped = closed;
          setError(locale === "ja"
            ? (stopped ? "一部の音声を文字にできませんでした。受信済みの音声の処理は続けます。下書きは保持しています。"
              : timedOut ? "文字起こしが時間切れになりましたが、受付は続けています。最後の部分をもう一度話してください。下書きは保持しています。"
              : "一部の音声を文字にできませんでしたが、受付は続けています。話し続けられます。下書きは保持しています。")
            : (stopped ? "Some audio could not be transcribed. Accepted audio will finish; the draft is retained."
              : timedOut ? "Transcription timed out, but listening continues. Repeat the last part; the draft is retained."
              : "Some audio could not be transcribed, but listening continues. Keep talking; the draft is retained."));
        }
      }).finally(() => {
        requests--; if (valid()) {setBusy(requests > 0); if (closed && requests === 0) {
          controls.current = null; yieldMicrophone(abort);
        }}
        pumpBacklog();
      });
    };
    const pumpBacklog = () => {
      if (!valid() || closed || requests >= 2) return;
      const next = backlog.shift();
      if (!next) {refreshBacklogNotice(); return;}
      backlogSamples -= batchSamples(next.frames);
      runBatch(next.frames, next.rate, next.review);
      refreshBacklogNotice();
    };
    const submit = () => {
      if (!voiced || !frames.length || !context) {frames = []; samples = 0; silent = 0; voiced = false; return;}
      const batch = frames, rate = context.sampleRate, capturedReview = speechReviewEpoch;
      frames = []; samples = 0; silent = 0; voiced = false;
      if (requests >= 3) {
        // Buffer instead of pausing capture: the mic stays open and buffered
        // utterances transcribe automatically as slots free up.
        backlog.push({frames: batch, rate, review: capturedReview});
        backlogSamples += batchSamples(batch);
        while (backlogSamples > BACKLOG_MAX_SAMPLES && backlog.length) {
          const dropped = backlog.shift()!;
          backlogSamples -= batchSamples(dropped.frames);
          logVoiceEvent("capture.backlog.drop", "oldest buffered utterance spilled");
        }
        logVoiceEvent("capture.backlog", `${backlog.length} buffered`);
        refreshBacklogNotice();
        return;
      }
      runBatch(batch, rate, capturedReview);
    };
    controls.current = {abort: () => { logVoiceEvent("capture.stop", "cancel"); abort(); }, markReview:epoch=>node?.port.postMessage({type:"review",epoch}), stop: () => { if (!closed && valid()) logVoiceEvent("capture.stop", requests || backlog.length ? "user stop; accepted audio continues" : "user stop"); if (!closed) {submit(); while (backlog.length && valid()) {const next = backlog.shift()!; backlogSamples -= batchSamples(next.frames); runBatch(next.frames, next.rate, next.review);} refreshBacklogNotice(); cleanup();} if (!requests) controls.current = null; }};
    takeMicrophone(abort);
    setError("");setNotice(""); setRecording(true);
    logVoiceEvent("capture.start", continuous ? "shared microphone" : "local microphone");
    try {
      stream = await navigator.mediaDevices.getUserMedia({audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true}});
      if (!valid() || closed) {stream.getTracks().forEach(track => track.stop()); return;}
      context = new AudioContext(); await context.resume();
      await context.audioWorklet.addModule("/voice-capture-v2.js");
      if (!valid() || closed) {cleanup(); return;}
      node = new AudioWorkletNode(context, "voice-capture", {processorOptions:{reviewEpoch:reviewEpoch.current}});
      context.createMediaStreamSource(stream).connect(node); node.connect(context.destination);
      node.port.onmessage = (event: MessageEvent<{samples:Float32Array;reviewEpoch:number}>) => {
        if (closed || !valid() || !context) return;
        const frame = event.data.samples, rate = context.sampleRate;
        const rms = Math.sqrt(frame.reduce((n, x) => n + x * x, 0) / frame.length);
        const speech = rms >= 0.012;
        if (speech) {if(!voiced)speechReviewEpoch=event.data.reviewEpoch;voiced = true; silent = 0;} else silent += frame.length;
        frames.push(frame); samples += frame.length;
        // Keep a short lead-in; never upload an idle microphone.
        if (!voiced && samples > rate * 0.3) {samples -= frames.shift()!.length;}
        // Local silence detection only delimits audio. Muse does all transcription.
        if (voiced && ((silent >= rate * VOICE_SILENCE_MS / 1000&&requests<2) || samples >= rate * 29)) {
          submit(); if (!continuous) cleanup();
        }
      };
      stream.getTracks().forEach(track => {track.onended = () => {if (!closed && valid()) {logVoiceEvent("capture.disconnect", "microphone track ended");
          controls.current?.stop();setError(locale === "ja" ? "マイクが切断されました。受信済みの音声の処理後に再開してください。" : "Microphone disconnected. Resume after accepted audio finishes.");}};});
    } catch {
      logVoiceEvent("capture.error", "getUserMedia failed");
      if (valid()) {abort(); setError(locale === "ja" ? "マイクを開始できません。権限と対応ブラウザを確認してください。" : "Could not start microphone. Check permission and browser support.");}
    }
  }
  return {recording, busy, supported, error,notice, start, stop, cancel, markReview};
}
