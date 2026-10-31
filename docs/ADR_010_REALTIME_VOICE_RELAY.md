# ADR-010: Realtime voice relay through the Python backend

Status: Accepted (fixture-verified; real Meta realtime path unverified).

## Context and decision

Phase A kept REST batch transcription (`POST /api/voice/transcribe`) as the
only audio path. Phase B adds an opt-in realtime path so long pauses,
self-corrections, and specialty terms stream as turn events without ending
the microphone session or the working draft.

The browser never receives `MODEL_API_KEY`. The browser fetches a
single-use, short-lived ticket from `POST /api/voice-ticket` (existing
preview + `DEMO_ACCESS_TOKEN` chain, forwarded to `POST /demo/ws-ticket`),
opens a WebSocket to the Python backend (`/demo/voice-realtime`), and the
backend dials Meta `wss://api.meta.ai/v1/asr/realtime` as the WS client.
The Next serverless tier never holds the long-lived socket.

## Verified provider contract

Meta `speech-to-text` docs (`https://dev.meta.ai/docs/speech-to-text`):
first frame is the handshake JSON with a 10s deadline, audio is signed
16-bit LE mono PCM (`PCM_24KHZ` used here), `mode: ENDPOINTING` is
session-fixed, `keywords` + `languageBias` are set at start and cannot
change mid-session, turns arrive as `speechStart` / `transcript(final)`
/ `speechEnd` / `speechComplete`, backlog over 5s must not be sent, audio
goes out in real time with silence PCM continued, default session limit is
60 minutes with reconnect. Official quickstart uses `websockets`, which is
why `requirements-api.txt` gains that single dependency.

## Language and vocabulary

English is the base language and Japanese is the formal counterpart, per
the Phase B correction (no Italian special-casing). `languageBias` reuses
the existing UI locale: `ja` maps to `["Japanese", "English"]`, anything
else to `["English", "Japanese"]`. Keywords are assembled per connection
from owner-scoped master rows plus current recipe context; no independent
persistent dictionary is created, and an empty master yields no keywords.
The docs state no keyword count limit, so a conservative cap of 50 is
applied and recorded in code.

## Turn contract (SSOT: `voice-turn-store.ts`)

- `transcript` events are provisional display info only, **even with
  `final:true`**. They never commit and never reach Muse.
- `speechComplete` is the sole committed transcript, once per `turnId`,
  and its body is the canonical text (it may differ from earlier partials).
- `speechEnd` is a boundary signal only; it never commits a draft update.
- Duplicates are ignored and lost turns are never fabricated.
- Overlapping turns and out-of-order delivery are keyed by `turnId`.
- The transport (`voice-realtime-transport.ts`) holds no duplicate turn
  state: it delegates every turn event to the shared store, which survives
  session refresh and reconnects so committed turns are never re-sent.

## Audio path (browser)

`useRealtimeVoiceCapture` reuses `/voice-capture-v2.js` and the single-mic
arbitration in `useVoiceCapture.ts`: starting one input stops the other,
and neither path discards a draft. Each worklet frame is resampled to
24kHz/16-bit mono (`voice-realtime-audio.ts`, pure and fixture-tested) and
a 100ms pacer releases only audio that has actually elapsed in real time,
so silence PCM continues and the 5s backlog cap is enforced over the total
pending buffer (oldest audio dropped, draft untouched). A proactive
refresh with a fresh ticket happens at 55 minutes, before Meta's 60-minute
limit; one automatic reconnect is attempted on unexpected loss, otherwise
the UI shows the stop reason and guides the user to resume. The relay
origin is the public (non-secret) `NEXT_PUBLIC_DEMO_WS_URL`; when unset,
realtime reports unconfigured and REST remains the path. VoiceWorkspace
exposes a mode toggle (REST default) sharing the same receive queue and
review-epoch domain, so realtime transcripts obey the same mode-boundary
and approval guards.

## Safety (unchanged)

Silence, `speechEnd`, ticket failure, relay errors, and disconnects never
discard a draft and never confirm a save. `POST /confirm` remains the only
approval path; transcription cannot write recipes, adopt prices, or bypass
the Human Gate. Diagnostics carry sequence/kind/trace only — no audio,
keys, or full utterances.

## Ops constraints (not permanent spec)

- `MODEL_API_KEY` lives only in server routes and the Python backend; the
  browser carries the single-use ticket alone (verified by code inspection).
- Tickets are single-use and short-lived; unknown/replayed tickets close
  the socket with 4401 (tested at the protocol level).
- The ticket store is in-memory: consistent on the current single-worker
  Render setup (`render.yaml` starts one uvicorn worker). A multi-worker
  layout would need a shared ticket store first; do not assume otherwise.
- No approval path is added: realtime transcripts enter the existing
  receive queue only. `POST /confirm` remains the sole approval.

## Verification

- `tests/test_voice_realtime.py` (9): language bias, keyword assembly/cap,
  handshake shape, ticket single-use/expiry, backlog guard, ticket endpoint
  (200/403, owner-scoped keywords), WS without ticket (4401), WS ticket
  replay (first use ok, replay 4401). The suite neutralizes MODEL_API_KEY
  so no test touches the network.
- `web/tests/voice-realtime.spec.ts` (3): the real TS modules, transpiled
  in the spec, checked in a real browser — partial/end/dedup, final:true
  never commits with speechComplete canonical, resampling/silence/endpoint.
- Real Meta realtime audio, Render WS behavior, and on-device microphone
  capture are explicitly unverified; REST batch stays the default path.
