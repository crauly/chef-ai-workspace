# Protected chef approval workflow

This single-workspace MVP has no product user accounts or login screen.
The preview uses an operator HTTP Basic access gate (`chef` plus a shared
password). The browser's native access prompt protects both the page and API;
it is separate from future Supabase Auth accounts. Use HTTPS in deployments.

## Server-only configuration

- `DEMO_PREVIEW_PASSWORD`: independent, random ASCII secret of at least 24 characters.
  With no strong password configured, requests are denied (including locally).
- `FASTAPI_BASE_URL`: trusted backend HTTPS origin; HTTP is allowed only for loopback development.
- `DEMO_ACCESS_TOKEN`: backend-only demo token, distinct from the preview password.

Never prefix these with `NEXT_PUBLIC_`. `MODEL_API_KEY` is server-only in the
Next.js runtime for the existing intent/draft routes and new Muse Voice route;
never expose it to client components. Supabase credentials remain in the
Python backend, which owns persistence and the fixed demo owner. Keep that
backend's demo endpoints token-protected.
Use only dedicated Supabase project `dfvryaybdelgjxihdmth`.
Restaurant operations project `jfaxjgvqfsacprenodkg` is strictly out of scope.
This UI change requires no schema migration.

The proxy independently checks preview authorization and same-origin POSTs,
allows only fixed recipe endpoints, rejects invalid UUID paths, avoids caching
and redirects, and does not expose upstream error bodies or headers.
Deployment-provider restricted access may be added outside this gate.

## Interaction

1. Open a recipe and type an instruction (Japanese or English).
2. Request a proposal. FastAPI validates it on a copy without persisting.
3. Read the original instruction and each before/after change. Empty or stale
   proposals cannot be approved. Editing the instruction discards the proposal.
4. Check approval of every proposed value, then press the explicit approval
   button. Only that action calls `/confirm`, with the proposal's base revision,
   one stable request UUID and `save_version=true`. Network retries reuse the UUID.
5. FastAPI validates, recalculates deterministically and atomically persists the
   revision/snapshot. The UI reloads current cost. Conflicts reload the selected
   recipe automatically and require a fresh proposal and approval.
6. Optional: explicitly register original/preferred phrases in correction history.
   This does not mutate the recipe or automatically accept subsequent suggestions.

The backend supports a dedicated Meta Responses adapter through server-only
`MODEL_API_KEY`; see [Meta integration](../docs/META_RESPONSES.md). Model attribution
is displayed with each proposal. Substitute adapters and browser fixtures are
not evidence of Muse behavior; no automatic fallback is introduced. Codex CLI's
401 is a separate authentication path. Live voice/database evidence is tracked
separately in [VOICE_ACCEPTANCE.md](../docs/VOICE_ACCEPTANCE.md); photo and
physical-device validation are outside this voice change.

## Audio input

Voice browse commands now use Muse's recipe-name target to search the owner's
saved library before pagination. A single match opens its detail read-only;
multiple matches remain visible for selection. The name search field offers
the same lookup, with clear/no-match behavior. Queries are bounded to 200
characters; old responses cannot replace a newer search. Search never calls
creation, proposal approval or save endpoints.

All microphone entry points use Web Audio, not browser speech recognition.
HTTPS (or localhost), microphone permission and AudioWorklet support are
required; typed input remains available. Audio is sent to Meta through the
protected server-only `/api/voice/transcribe` route. The app does not retain
recordings. Pause for about one second between turns. A save request such as
「保存してください」first presents the current draft for review; a later explicit
request approves that reviewed draft. A combined review/save sentence is one
request and cannot approve a draft that was not already presented. The stop
button flushes the last voiced segment. Changing
microphones, discarding a draft, navigation or a transcription error cancels
pending audio. On failure, review the visible draft before restarting.

The route accepts canonical mono PCM WAV at 16/24 kHz, up to 30 seconds, and
validates bytes before calling Muse Voice. Web emits 24 kHz WAV; a future native
client may reuse the same authenticated contract. No new server secret or
deployment configuration is required beyond the existing `MODEL_API_KEY`.
See [ADR-007](../docs/ADR_007_MUSE_VOICE_INPUT_BOUNDARY.md).

The repository-root `vercel.json` disables automatic Git deployments for the review branch
`feat/muse-voice-transcription` only, honoring the no-deployment scope of this
initial PR. The follow-up review branch `fix/voice-recipe-retrieval` is also
disabled; other branches retain their existing behavior. This follows Vercel's
[branch deployment configuration](https://vercel.com/docs/project-configuration/git-configuration).

`tests/voice-transcription.spec.ts` covers transport/schema failures, route
access/size/format protection and actual Chromium audio encoding with fixture
transcription. It does not send real recordings to Meta or touch Supabase.
`tests/live-voice.spec.ts` is separately opt-in and has passed with actual Muse
Voice/Spark and dedicated Supabase. It uses Japanese synthetic speech through
the actual Web Audio capture path. The Web hackathon scope does not require a
native app or a physical smartphone. Real kitchen noise and arbitrary speakers
remain usability evaluation, not a claim of these automated tests.

## Verification

`npm ci`, `npm run build`, `npm run typecheck`, `npx playwright install chromium`,
`npm test`. CI runs the build, typecheck and browser scenarios. Browser tests
use an isolated local fixture backend with no database or real model. Python
tests additionally exercise real FastAPI validation, deterministic mutation/cost,
explicit confirmation, replay, conflicts and correction registration using an
in-memory repository. These do not prove live Supabase or real inference.

For the separately executed live test, dedicated test-owner creation and
verified cleanup, see [VOICE_ACCEPTANCE.md](../docs/VOICE_ACCEPTANCE.md).

For natural save requests, visible culinary title suggestions, retry behavior,
capture-time approval boundaries and measured latency limits, see
[the conversation regression report](../docs/VOICE_CONVERSATION_FIX.md).
Review/save controls do not make another Spark request.
