# ADR-007: Separate audio capture, Muse transcription and culinary interpretation

Status: Accepted for implementation (2026-10-29); live Voice inference and device acceptance pending.

## Context and decision

PR #47 buffered browser-generated text fragments. That still delegated speech
recognition to the browser. Replace that dependency at all three entry points
with Web Audio capture. Web captures audio; the Next.js server calls Muse Voice
Transcribe; existing Muse Spark logic interprets recipe intent, terminology,
quantities, packaging prices and corrections. Python retains validation,
deterministic costing and persistence. No new provider abstraction or database.

The existing Human Gate remains authoritative: full registration requires a
separate review turn and explicit save, with missing/ambiguous data blocking it.
Editing an existing recipe retains its proposal diff, checkbox and `/confirm`
route. Transcription cannot write recipes or approve changes. Raw transcript
text reaches the existing semantic boundary unchanged.

## Verified provider contract

Verified against [Meta speech-to-text documentation](https://dev.meta.ai/docs/speech-to-text)
and the [official Voice cookbook](https://github.com/meta-models/meta-model-cookbook/tree/main/06_muse_voice/01_voice_api_fundamentals)
on 2026-10-29. The schema reference requires sign-in in this environment; the
public feature page and official cookbook provide the implemented file contract.

- Recording endpoint: `POST https://api.meta.ai/v1/asr/transcribe`.
- Server-only `Authorization: Bearer MODEL_API_KEY`.
- Multipart `request` JSON: `model=muse-voice-transcribe-1.0`,
  `mode=PUSH_TO_TALK`, `audioEncoding=WAV`, `languageBias=[Japanese]` or `[English]`.
- Multipart `audio`: mono, signed 16-bit PCM RIFF/WAVE at 16 or 24 kHz.
- JSON response: use the top-level `transcript`. Japanese is explicitly supported.

Do not use `/audio/transcriptions`, assume WebM/MP4 support, or put credentials
in a browser WebSocket. Official availability is not proof this account can
invoke Voice or that it recognizes a particular kitchen recording correctly.

## Application audio boundary

`POST /api/voice/transcribe` receives raw `audio/wav`, with
`X-Audio-Language: ja | en-US`. Only a canonical 44-byte WAV header plus PCM
data is accepted: mono, 16-bit, 16/24 kHz, at most 30 seconds/1,440,044 bytes.
Reject wrong headers, inconsistent lengths, empty audio and oversized bodies
before provider access. Return `{transcript, provider, model}` only; no
provider error details or session identifiers. Transcripts over 1,000 characters
are rejected rather than silently truncated to fit the existing semantic API.

The current operator Basic gate and exact same-origin POST check also apply.
The audio route owns that gate and the same no-store/security headers directly.
It is excluded from middleware matching because full binary uploads reproduced
the Node middleware body-cloning error before route execution (also reported
in [Next.js #83453](https://github.com/vercel/next.js/issues/83453)). Authentication
is still mandatory inside the handler, including for middleware-bypass headers.
A native client can emit this same WAV contract and use the authorized gateway
(including its required Origin header). This ADR does not add native accounts,
weaken auth, or claim that a native app already exists. Future production auth
must follow ADR-006.

Web uses an AudioWorklet and resamples to 24 kHz with OfflineAudioContext.
A 3.5-second quiet gap delimits an utterance; 29 seconds caps a segment. These
are local recording heuristics, not linguistic interpretation or provider VAD.
Continuous recipe capture queues at most three segments; overload or failure
stops recording and discards unsent audio with an explicit recovery message.
Other inputs capture one utterance. Stopping sends the last voiced segment;
cancelling, leaving the component or switching microphones discards pending
audio. Only one microphone operates across the three entry points.

No audio file, transcript analytics or new correction log is persisted by this
endpoint. Audio exists transiently in memory and is sent to Meta, as disclosed
before recording. This does not assert a provider-side retention policy.

## Verification and tradeoffs

Fixture transport tests verify exact multipart/auth/schema and failures.
Browser tests exercise actual Web Audio/worklet/WAV encoding with a synthetic
microphone, then fixture transcription and existing Human Gate. These are not
evidence of live Muse recognition. Existing Python and browser approval tests
remain required. Live Japanese speech, cooking noise, mobile permission/recovery,
latency and complete live database E2E remain acceptance work.

Batch WAV is the smallest deployable change using the current Next.js backend;
it adds silence and upload latency. Realtime WebSocket endpointing is deferred
until evidence justifies an additional streaming server. No merge or deployment
is part of this change.
