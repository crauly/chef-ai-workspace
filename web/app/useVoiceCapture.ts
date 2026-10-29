"use client";
import {useEffect, useRef, useState} from "react";
import type {Locale} from "./i18n";

// One microphone across all entry points. Never run overlapping voice sessions.
let releaseMicrophone: (() => void) | undefined;
export const VOICE_SILENCE_MS = 1000;
export type VoiceCaptureMeta = {reviewEpoch: number};

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
    const aborter = new AbortController();
    const cleanup = () => {
      closed = true; stream?.getTracks().forEach(track => track.stop());
      if (node) {node.port.onmessage = null; node.disconnect();}
      if (context && context.state !== "closed") void context.close();
      if (valid()) setRecording(false);
      if (!requests && releaseMicrophone === abort) releaseMicrophone = undefined;
    };
    const abort = () => {
      cleanup(); aborter.abort(); ++generation.current; controls.current = null;
      if (releaseMicrophone === abort) releaseMicrophone = undefined;
      if (mounted.current) {setRecording(false); setBusy(false);}
    };
    const submit = () => {
      if (!voiced || !frames.length || !context) {frames = []; samples = 0; silent = 0; voiced = false; return;}
      const batch = frames, rate = context.sampleRate, capturedReview = speechReviewEpoch;
      frames = []; samples = 0; silent = 0; voiced = false;
      // Bound queued audio when the network or semantic parser is slow.
      if (requests >= 3) {abort(); setError(locale === "ja" ? "通信が追いつきません。内容を確認して再開してください。" : "Connection is too slow. Review and restart."); return;}
      requests++; setBusy(true);
      pending = pending.then(async () => {
        if (!valid()) return;
        const wav = await encodeWav(batch, rate);
        if (!valid()) return;
        const response = await fetch("/api/voice/transcribe", {method: "POST",
          headers: {"Content-Type": "audio/wav", "X-Audio-Language": locale}, body: wav,
          signal: AbortSignal.any([aborter.signal, AbortSignal.timeout(35_000)])});
        if (!response.ok) throw new Error("transcription");
        const result: unknown = await response.json();
        const text = result && typeof result === "object" ? (result as {transcript?: unknown}).transcript : null;
        if (typeof text !== "string" || !text.trim() || text.length > 1000) throw new Error("transcription");
        if (valid()) callback.current(text, {reviewEpoch:capturedReview});
      }).catch(() => {
        if (valid()) {abort(); setError(locale === "ja" ? "音声を文字にできませんでした。未送信の音声は破棄しました。内容を確認して再開してください。" : "Transcription failed. Unsent audio discarded. Review and restart.");}
      }).finally(() => {
        requests--; if (valid()) {setBusy(requests > 0); if (closed && requests === 0) {
          controls.current = null; if (releaseMicrophone === abort) releaseMicrophone = undefined;
        }}
      });
    };
    controls.current = {abort, markReview:epoch=>node?.port.postMessage({type:"review",epoch}), stop: () => {if (!closed) {submit(); cleanup();} if (!requests) controls.current = null;}};
    releaseMicrophone = abort;
    setError(""); setRecording(true);
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
        if (voiced && (silent >= rate * VOICE_SILENCE_MS / 1000 || samples >= rate * 29)) {
          submit(); if (!continuous) cleanup();
        }
      };
      stream.getTracks().forEach(track => {track.onended = () => {if (!closed && valid()) {abort(); setError(locale === "ja" ? "マイクが切断されました。再開してください。" : "Microphone disconnected. Restart recording.");}};});
    } catch {
      if (valid()) {abort(); setError(locale === "ja" ? "マイクを開始できません。権限と対応ブラウザを確認してください。" : "Could not start microphone. Check permission and browser support.");}
    }
  }
  return {recording, busy, supported, error, start, stop, cancel, markReview};
}
