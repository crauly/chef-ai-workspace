"use client";
// Phase B opt-in realtime capture. REST batch remains the default fallback.
// Silence / speechEnd / disconnect never discard a draft; speechComplete is
// the only committed transcript handed to the existing draft pipeline.
import {useEffect, useRef, useState} from "react";
import type {Locale} from "./i18n";
import {logVoiceEvent} from "./voice-diagnostics";
import {VoiceTurnStore} from "./voice-turn-store";
import {RealtimeTransport, type RealtimeState, type SocketLike} from "./voice-realtime-transport";
import type {VoiceCaptureMeta} from "./useVoiceCapture";

export function realtimeWsEndpoint(): string {
  const base = process.env.NEXT_PUBLIC_DEMO_WS_URL ?? "";
  return base ? base.replace(/\/$/, "") + "/demo/voice-realtime" : "/demo/voice-realtime";
}

function wrapBrowserSocket(socket: WebSocket): SocketLike {
  let messageHandler: ((ev: {data: unknown}) => void) | null = null;
  let closeHandler: ((ev: {code: number}) => void) | null = null;
  let errorHandler: (() => void) | null = null;
  socket.onmessage = ev => messageHandler?.({data: ev.data});
  socket.onclose = ev => closeHandler?.({code: ev.code});
  socket.onerror = () => errorHandler?.();
  return {
    send: data => socket.send(data),
    close: code => socket.close(code),
    set onmessage(notify) { messageHandler = notify; },
    get onmessage() { return messageHandler; },
    set onclose(notify) { closeHandler = notify; },
    get onclose() { return closeHandler; },
    set onerror(notify) { errorHandler = notify; },
    get onerror() { return errorHandler; },
  };
}

export function useRealtimeVoiceCapture(
  locale: Locale,
  onTranscript: (text: string, meta?: VoiceCaptureMeta) => void,
) {
  const [state, setState] = useState<RealtimeState>("idle");
  const [partial, setPartial] = useState("");
  const callback = useRef(onTranscript); callback.current = onTranscript;
  const transport = useRef<RealtimeTransport | null>(null);
  const turns = useRef(new VoiceTurnStore());
  const reviewEpoch = useRef(0);
  const traceCounter = useRef(0);
  useEffect(() => () => transport.current?.close(), []);

  function markReview(): number { return ++reviewEpoch.current; }

  async function start(contextTerms: string[] = []): Promise<void> {
    if (transport.current) return;
    const trace = `${Date.now().toString(36)}-${++traceCounter.current}`;
    logVoiceEvent("capture.start", "realtime opening", trace);
    setState("connecting");
    let ticket = "";
    try {
      const response = await fetch("/api/voice-ticket", {
        method: "POST", headers: {"Content-Type": "application/json"},
        body: JSON.stringify({locale: locale === "ja" ? "ja" : "en", context_terms: contextTerms}),
      });
      if (!response.ok) throw new Error("ticket");
      const data = (await response.json()) as {ticket?: unknown};
      if (typeof data.ticket !== "string" || !data.ticket) throw new Error("ticket");
      ticket = data.ticket;
    } catch {
      logVoiceEvent("capture.error", "realtime ticket failed; draft kept", trace);
      setState("failed");
      return;
    }
    const active = new RealtimeTransport(
      url => wrapBrowserSocket(new WebSocket(url)),
      {
        onState: next => {
          setState(next);
          if (next === "failed" || next === "closed") {
            logVoiceEvent(next === "failed" ? "capture.error" : "capture.stop", "realtime ended; draft kept", trace);
            if (transport.current === active) transport.current = null;
          }
        },
        onPartial: text => setPartial(text.slice(0, 200)),
        onCommitted: (text, turnId) => {
          turns.current.handle({type: "speechComplete", turnId, text});
          setPartial("");
          logVoiceEvent("transcribe.ok", "realtime turn committed", trace);
          callback.current(text, {reviewEpoch: reviewEpoch.current, traceId: trace});
        },
      },
    );
    transport.current = active;
    active.connect(realtimeWsEndpoint(), ticket);
  }

  function stop(): void {
    transport.current?.finish();
    transport.current?.close();
    transport.current = null;
    setState("closed");
  }

  return {state, partial, start, stop, markReview};
}
