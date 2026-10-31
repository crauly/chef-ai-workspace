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

- `partial` is display-only and overwrites the same turn.
- `speechEnd` is a boundary signal only; it never commits a draft update.
- `speechComplete` is the sole committed transcript, once per `turnId`;
  duplicates are ignored and lost turns are never fabricated.
- Overlapping turns and out-of-order delivery are keyed by `turnId`.

## Safety (unchanged)

Silence, `speechEnd`, ticket failure, relay errors, and disconnects never
discard a draft and never confirm a save. `POST /confirm` remains the only
approval path; transcription cannot write recipes, adopt prices, or bypass
the Human Gate. Diagnostics carry sequence/kind/trace only — no audio,
keys, or full utterances.

## Verification

- `tests/test_voice_realtime.py`: language bias, keyword assembly/cap,
  handshake shape, ticket single-use/expiry, backlog guard, ticket endpoint
  (200/403, owner-scoped keywords).
- `web/tests/voice-realtime.spec.ts`: the real TS modules, transpiled in
  the spec, checked in a real browser — partial/end/dedup/backlog.
- Real Meta realtime audio, Render WS behavior, and on-device microphone
  capture are explicitly unverified; REST batch stays the default path.
