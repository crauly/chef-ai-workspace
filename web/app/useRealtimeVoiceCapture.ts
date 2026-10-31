"use client";
// Phase B realtime capture: microphone -> 24kHz/16-bit mono PCM ->
// authenticated Python relay -> Meta Realtime ASR -> speechComplete ->
// the shared VoiceWorkspace queue -> Muse Spark -> draft.
// REST batch remains the default path and the fallback.
//
// Safety contract (unchanged):
// - Silence, speechEnd, ticket/relay/mic failures, session refresh, and
//   reconnects never discard a draft and never confirm a save.
// - Only speechComplete transcripts reach the draft pipeline, via the same
//   receive() queue as REST. No confirm/save path is added here.
// - Single microphone: starting realtime stops REST capture and vice versa.
import {useEffect, useRef, useState} from "react";
import type {Locale} from "./i18n";
import {logVoiceEvent} from "./voice-diagnostics";
import {VoiceTurnStore} from "./voice-turn-store";
import {
  RealtimeTransport,
  type RealtimeState,
  type SocketLike,
} from "./voice-realtime-transport";
import {takeMicrophone, yieldMicrophone, type VoiceCaptureMeta} from "./useVoiceCapture";

import {
  REALTIME_BACKLOG_BYTES,
  REALTIME_DRAIN_TIMEOUT_MS,
  REALTIME_MAX_SEND_SAMPLES,
  REALTIME_REFRESH_MS,
  REALTIME_SAMPLE_RATE,
  REALTIME_SEND_INTERVAL_MS,
  realtimeWsEndpoint,
  resampleTo24kMono,
} from "./voice-realtime-audio";

function wrapBrowserSocket(socket: WebSocket): SocketLike {
  let openHandler: (() => void) | null = null;
  let messageHandler: ((ev: {data: unknown}) => void) | null = null;
  let closeHandler: ((ev: {code: number}) => void) | null = null;
  let errorHandler: (() => void) | null = null;
  // The ticket leaves only after the socket opens; nothing is sent while
  // the connection is still being established.
  socket.onopen = () => openHandler?.();
  socket.onmessage = ev => messageHandler?.({data: ev.data});
  socket.onclose = ev => closeHandler?.({code: ev.code});
  socket.onerror = () => errorHandler?.();
  return {
    send: data => socket.send(data),
    close: code => socket.close(code),
    set onopen(notify) { openHandler = notify; },
    get onopen() { return openHandler; },
    set onmessage(notify) { messageHandler = notify; },
    get onmessage() { return messageHandler; },
    set onclose(notify) { closeHandler = notify; },
    get onclose() { return closeHandler; },
    set onerror(notify) { errorHandler = notify; },
    get onerror() { return errorHandler; },
  };
}

type Session = {
  stream: MediaStream;
  context: AudioContext;
  node: AudioWorkletNode;
  transport: RealtimeTransport;
  timer: ReturnType<typeof setInterval>;
  refreshTimer: ReturnType<typeof setTimeout>;
  outbox: Int16Array[];
  outboxSamples: number;
  sentSamples: number;
  startedAt: number;
  trace: string;
  retries: number;
  userStop: boolean;
  refreshing: boolean;
  micGone: boolean;
  inRate: number;
};

export function useRealtimeVoiceCapture(
  locale: Locale,
  onTranscript: (text: string, meta?: VoiceCaptureMeta) => void,
  opts: {getEpoch?: () => number} = {},
) {
  const [state, setState] = useState<RealtimeState>("idle");
  const [recording, setRecording] = useState(false);
  const [partial, setPartial] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const callback = useRef(onTranscript); callback.current = onTranscript;
  const epochOf = useRef(opts.getEpoch); epochOf.current = opts.getEpoch;
  const session = useRef<Session | null>(null);
  const turns = useRef(new VoiceTurnStore());
  const fallbackEpoch = useRef(0);
  const traceCounter = useRef(0);
  const mounted = useRef(true);
  // Invalidates a start() that is still awaiting microphone/audio/ticket.
  // Bumped by stop() and on unmount so a late async step tears down instead
  // of opening a connection nobody owns. Draft is never touched here.
  const startEpoch = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { startEpoch.current++; mounted.current = false; stopSession(true); };
  }, []);

  function markReview(): number { return ++fallbackEpoch.current; }
  const alive = () => mounted.current && session.current !== null;

  // Mic-arbitration release (e.g. REST capture starts): end intake now but
  // still drain the final transcript like a user stop. Draft is always kept.
  function stopAll(): void { if (session.current) stop(); }
  /** Stop microphone and pacer immediately. The transport may outlive this
      for the endStream drain; finalizeDrain completes the session. */
  function endAudioIntake(current: Session): void {
    clearInterval(current.timer);
    clearTimeout(current.refreshTimer);
    try { current.stream.getTracks().forEach(track => track.stop()); } catch { /* ignore */ }
    try { current.node.port.onmessage = null; current.node.disconnect(); } catch { /* ignore */ }
    if (current.context.state !== "closed") void current.context.close().catch(() => {});
    yieldMicrophone(stopAll);
    if (mounted.current) setRecording(false);
  }
  function finalizeDrain(current: Session): void {
    if (session.current !== current) return;
    session.current = null;
    try { current.transport.close(); } catch { /* ignore */ }
    if (mounted.current) { setPartial(""); setState("closed"); }
  }
  function stopSession(silent: boolean): void {
    const current = session.current;
    if (!current) {
      yieldMicrophone(stopAll);
      if (mounted.current && !silent) setState("closed");
      return;
    }
    current.userStop = current.userStop || silent;
    endAudioIntake(current);
    session.current = null;
    try { current.transport.finish(); } catch { /* ignore */ }
    try { current.transport.close(); } catch { /* ignore */ }
    if (mounted.current && !silent) setState("closed");
  }

  function failReason(trace: string, reason: string, message: string): void {
    logVoiceEvent("capture.error", reason, trace);
    stopSession(true);
    if (mounted.current) {
      setError(message);
      setNotice(locale === "ja"
        ? "下書きは保持しています。通常の音声入力も利用できます。"
        : "The draft is retained. Standard voice input remains available.");
      setState("failed");
    }
  }

  function pushPcm(frame: Int16Array): void {
    const current = session.current;
    if (!current || current.userStop) return;
    current.outbox.push(frame);
    current.outboxSamples += frame.length;
    // Total pending backlog cap: drop oldest audio beyond 5s, never the draft.
    const cap = REALTIME_BACKLOG_BYTES / 2;
    if (current.outboxSamples > cap) {
      let excess = current.outboxSamples - cap;
      while (excess > 0 && current.outbox.length) {
        const head = current.outbox[0];
        if (head.length <= excess) { current.outbox.shift(); current.outboxSamples -= head.length; excess -= head.length; }
        else { current.outbox[0] = head.slice(excess); current.outboxSamples -= excess; excess = 0; }
      }
      logVoiceEvent("queue.dropped", "realtime backlog over 5s; oldest audio dropped", current.trace);
    }
  }

  function pump(): void {
    const current = session.current;
    if (!current || current.userStop) return;
    // Real-time pace: only audio that has actually elapsed since session
    // start may leave. Silence flows too, because the worklet emits
    // continuously while the microphone is open.
    const elapsed = (Date.now() - current.startedAt) / 1000;
    let due = Math.min(Math.floor(elapsed * REALTIME_SAMPLE_RATE) - current.sentSamples, REALTIME_MAX_SEND_SAMPLES);
    while (due > 0 && current.outbox.length && session.current === current) {
      const head = current.outbox[0];
      const take = Math.min(head.length, due);
      const bytes = new ArrayBuffer(take * 2);
      new Int16Array(bytes).set(head.subarray(0, take));
      const pendingBytes = current.outboxSamples * 2;
      if (!current.transport.sendPcm(bytes, pendingBytes)) return; // not ready or backlog: retry next tick
      if (take === head.length) current.outbox.shift();
      else current.outbox[0] = head.slice(take);
      current.outboxSamples -= take;
      current.sentSamples += take;
      due -= take;
    }
  }

  async function openTransport(current: Session, ticket: string, endpoint: string): Promise<void> {
    const active = new RealtimeTransport(
      url => wrapBrowserSocket(new WebSocket(url)),
      {
        onState: next => {
          if (session.current !== current) return;
          if (next === "ready") {
            current.retries = 0;
            setState("ready");
            logVoiceEvent("transcribe.ok", "realtime relay ready", current.trace);
          } else if (next === "draining") {
            if (mounted.current) setNotice(locale === "ja"
              ? "最終の認識結果を待っています。下書きは保持しています。"
              : "Waiting for the final transcript; the draft is retained.");
            return;
          } else if (next === "failed" || next === "closed") {
            // After a user stop the relay answers endStream with the final
            // speechComplete and then closes: finalize only now, so the late
            // transcript still commits through the shared store exactly once.
            if (current.userStop) { finalizeDrain(current); return; }
            if (current.refreshing) return;
            if (current.micGone) {
              failReason(current.trace, "microphone disconnected; draft kept",
                locale === "ja" ? "マイクが切断されました。下書きは保持しています。" : "Microphone disconnected. The draft is retained.");
              return;
            }
            if (current.retries < 1) {
              // One automatic reconnect with a fresh ticket; committed turns
              // stay committed in the shared store, so nothing is re-sent.
              current.retries++;
              logVoiceEvent("capture.disconnect", "relay lost; one reconnect attempt", current.trace);
              setNotice(locale === "ja" ? "接続が切れました。再接続しています。下書きは保持しています。" : "Connection lost. Reconnecting; the draft is retained.");
              void reconnect(current);
            } else {
              failReason(current.trace, "relay unavailable; draft kept",
                locale === "ja" ? "リアルタイム接続を利用できません。下書きは保持しています。「音声操作を再開」で再試行できます。" : "Realtime connection unavailable. The draft is retained; resume to retry.");
            }
          }
        },
        onPartial: text => { if (session.current === current) setPartial(text.slice(0, 200)); },
        onCommitted: (text, turnId) => {
          if (session.current !== current) return;
          setPartial("");
          logVoiceEvent("transcribe.ok", "realtime turn committed", current.trace);
          const epoch = epochOf.current?.() ?? fallbackEpoch.current;
          callback.current(text, {reviewEpoch: epoch, traceId: current.trace});
          void turnId;
        },
      },
      turns.current, // shared across refresh/reconnect: no duplicate commits
    );
    current.transport = active;
    active.connect(endpoint, ticket);
  }

  async function fetchTicket(trace: string, contextTerms: string[]): Promise<string | null> {
    try {
      const response = await fetch("/api/voice-ticket", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({locale: locale === "ja" ? "ja" : "en", context_terms: contextTerms}),
      });
      if (!response.ok) return null;
      const data = (await response.json()) as {ticket?: unknown};
      return typeof data.ticket === "string" && data.ticket ? data.ticket : null;
    } catch { return null; }
  }

  async function reconnect(current: Session): Promise<void> {
    if (session.current !== current || current.userStop) return;
    // Held until the replacement transport exists: the old socket's close
    // frame must not trigger a second reconnect.
    current.refreshing = true;
    try {
      const endpoint = realtimeWsEndpoint();
      if (!endpoint) { failReason(current.trace, "relay origin unconfigured", ""); return; }
      const ticket = await fetchTicket(current.trace + "-r", []);
      if (session.current !== current || current.userStop) return;
      if (!ticket) {
        failReason(current.trace, "ticket refresh failed; draft kept",
          locale === "ja" ? "再接続できませんでした。下書きは保持しています。" : "Could not reconnect. The draft is retained.");
        return;
      }
      try { current.transport.finish(); } catch { /* ignore */ }
      try { current.transport.close(); } catch { /* ignore */ }
      current.startedAt = Date.now();
      current.sentSamples = 0;
      current.outbox = [];
      current.outboxSamples = 0;
      await openTransport(current, ticket, endpoint);
      armRefresh(current);
    } finally {
      if (session.current === current) current.refreshing = false;
    }
  }

  function armRefresh(current: Session): void {
    clearTimeout(current.refreshTimer);
    current.refreshTimer = setTimeout(() => {
      if (session.current !== current || current.userStop) return;
      // Proactive refresh before the 60-minute session limit. The shared
      // turn store survives, so committed turns are never re-sent and
      // uncommitted partials are dropped without touching the draft.
      logVoiceEvent("capture.pause", "session refresh before 60-minute limit", current.trace);
      void reconnect(current);
    }, REALTIME_REFRESH_MS);
  }

  async function start(contextTerms: string[] = []): Promise<void> {
    if (session.current) return;
    const myStart = ++startEpoch.current;
    const stale = () => !mounted.current || myStart !== startEpoch.current;
    const trace = `${Date.now().toString(36)}-${++traceCounter.current}`;
    const endpoint = realtimeWsEndpoint();
    if (!endpoint) {
      logVoiceEvent("capture.error", "relay origin unconfigured; draft kept", trace);
      setError(locale === "ja"
        ? "リアルタイム音声は未設定です。通常の音声入力を利用してください。下書きは保持しています。"
        : "Realtime voice is not configured. Use standard voice input; the draft is retained.");
      setState("failed");
      return;
    }
    takeMicrophone(stopAll); // single microphone: stops REST capture, keeps its draft
    setError(""); setNotice(""); setPartial("");
    setState("connecting");
    logVoiceEvent("capture.start", "realtime microphone", trace);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true}});
    } catch {
      yieldMicrophone(stopAll);
      failReason(trace, "getUserMedia failed",
        locale === "ja" ? "マイクを開始できません。権限と対応ブラウザを確認してください。" : "Could not start microphone. Check permission and browser support.");
      return;
    }
    if (stale()) {
      // Stopped or unmounted while the microphone prompt was pending: never
      // proceed to audio setup or ticket fetch; keep the draft as-is.
      stream.getTracks().forEach(track => track.stop());
      yieldMicrophone(stopAll);
      return;
    }
    let context: AudioContext;
    let node: AudioWorkletNode;
    try {
      context = new AudioContext();
      await context.resume();
      await context.audioWorklet.addModule("/voice-capture-v2.js");
      node = new AudioWorkletNode(context, "voice-capture", {processorOptions: {reviewEpoch: 0}});
      context.createMediaStreamSource(stream).connect(node);
      node.connect(context.destination);
    } catch {
      stream.getTracks().forEach(track => track.stop());
      yieldMicrophone(stopAll);
      failReason(trace, "audio graph failed",
        locale === "ja" ? "音声処理を開始できませんでした。通常の音声入力を利用してください。" : "Could not start audio processing. Use standard voice input.");
      return;
    }
    if (stale()) {
      try { node.port.onmessage = null; node.disconnect(); } catch { /* ignore */ }
      if (context.state !== "closed") void context.close().catch(() => {});
      stream.getTracks().forEach(track => track.stop());
      yieldMicrophone(stopAll);
      return;
    }
    const ticket = await fetchTicket(trace, contextTerms);
    if (stale()) {
      try { node.port.onmessage = null; node.disconnect(); } catch { /* ignore */ }
      if (context.state !== "closed") void context.close().catch(() => {});
      stream.getTracks().forEach(track => track.stop());
      yieldMicrophone(stopAll);
      return;
    }
    if (!ticket) {
      try { node.port.onmessage = null; node.disconnect(); } catch { /* ignore */ }
      if (context.state !== "closed") void context.close().catch(() => {});
      stream.getTracks().forEach(track => track.stop());
      yieldMicrophone(stopAll);
      failReason(trace, "ticket failed; draft kept",
        locale === "ja" ? "リアルタイム接続を開始できません。通常の音声入力を利用してください。下書きは保持しています。" : "Could not start realtime. Use standard voice input; the draft is retained.");
      return;
    }
    const current: Session = {
      stream, context, node,
      transport: undefined as unknown as RealtimeTransport,
      timer: undefined as unknown as ReturnType<typeof setInterval>,
      refreshTimer: undefined as unknown as ReturnType<typeof setTimeout>,
      outbox: [], outboxSamples: 0, sentSamples: 0, startedAt: Date.now(),
      trace, retries: 0, userStop: false, refreshing: false, micGone: false,
      inRate: context.sampleRate,
    };
    session.current = current;
    node.port.onmessage = (event: MessageEvent<{samples: Float32Array}>) => {
      if (session.current !== current || current.userStop) return;
      pushPcm(resampleTo24kMono(event.data.samples, current.inRate));
    };
    stream.getTracks().forEach(track => {
      track.onended = () => {
        if (session.current !== current || current.userStop) return;
        current.micGone = true;
        logVoiceEvent("capture.disconnect", "microphone track ended", current.trace);
      };
    });
    current.timer = setInterval(pump, REALTIME_SEND_INTERVAL_MS);
    await openTransport(current, ticket, endpoint);
    armRefresh(current);
    if (alive()) setRecording(true);
  }

  function stop(): void {
    // Invalidate a start() that is still awaiting microphone/audio/ticket so
    // its late continuation tears down instead of connecting.
    startEpoch.current++;
    const current = session.current;
    if (!current) {
      if (mounted.current) setState("closed");
      return;
    }
    logVoiceEvent("capture.stop", "user stop realtime; draining final transcript", current.trace);
    current.userStop = true;
    endAudioIntake(current);
    // endStream first; the relay closes after the final speechComplete (or
    // the finite timeout fires). Either way the draft is kept and the late
    // transcript commits at most once via the shared store.
    current.transport.finishAndDrain(REALTIME_DRAIN_TIMEOUT_MS);
  }

  return {state, recording, partial, error, notice, start, stop, markReview};
}
