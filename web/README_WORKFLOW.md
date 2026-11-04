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

## Continuous voice workspace

The main screen now has one microphone and one fallback text input for
registration, reference and editing. Say “レシピを登録します”, dictate the
recipe, review and explicitly save; then “ペペロンチーノを見せて” and speak a
change. Each actual mode transition plays its distinct cue. No second microphone
must be started after saving or switching modes. Drafts remain when browsing;
pending edit proposals must be saved or discarded before leaving them. Multiple
search matches require target selection. See [ADR-008](../docs/ADR_008_UNIFIED_VOICE_WORKSPACE.md)
for routing, capture epochs and voice/manual confirmation boundaries.

After review, “登録”, “登録してください” and “レシピを登録してください”
all approve the current unchanged draft through the normal save gate. During
an active task these controls take precedence over navigation. If capture
pauses, a stop/error cue and capture status explain it. Accepted queued audio
finishes before “音声操作を再開” becomes available. The draft remains in the
page; do not reload to resume. A failed ASR segment is identified as failed
and may need repeating; other accepted segments are not discarded with it.

Voice draft latency, the single shared status panel, provider streaming boundaries,
fixture commands and production verification limits are documented in
[Voice UX pipeline](../docs/VOICE_UX_PIPELINE.md).

## Voice operation sequence (user operating procedure, 2026-11-04)

The operator-facing rule is **choose the task, confirm the active mode (and
recipe target for edits), then dictate**. Voice commands and the three visible
mode buttons are two entry points to the same guarded transition. Wait for the
mode indication and its cue before continuing with substantive dictation. The
microphone need not be restarted when switching modes.

- **Create / 登録**: select 登録 or say “レシピを登録します”; verify the
  displayed mode is 登録, then dictate the dish name, ingredients, quantities
  and prices. Read the unsaved draft, request review and explicitly approve
  the unchanged draft before saving. The auxiliary typed field passes text
  through the same Muse draft parser; it is not a structured manual form.
- **Browse / 参照**: select 参照 or ask for a recipe by name; verify the
  browse state and choose a unique recipe result. Browse does not change the
  saved recipe.
- **Edit / 編集**: **first open/select the recipe to be modified** by browsing
  or selecting it from the library. Only then select 編集 or ask to modify that
  recipe. On the home screen with no selected recipe, pressing 編集 alone is
  rejected with guidance to open a recipe first. Dictate the change, inspect
  the proposal and before/after diff, then explicitly approve before the
  existing `/api/recipes/{id}/confirm` write. If a requested recipe search
  is ambiguous, select a result before editing.

This is an **operating sequence, not a new hard enforcement rule**. Existing
backward-compatible direct dictation from idle may still enter create mode;
queued voice data is not intentionally discarded merely because it started
before the transition cue. Approval requests captured before the current
review/mode are still rejected, and pending edits cannot silently be dropped
by switching tasks. Do not confuse mode confirmation with permission to save.

**Manual recipe entry** is separately available in the home recipe library:
type a recipe name and create it, then edit its materials in the detail view.
The mode buttons do not themselves implement a manual ingredient form.

**Procurement UI terminology warning:** Ingredient management currently labels
an abstract, owner-scoped Supplier as `相場参考価格` (market reference price).
Selecting it in `仕入れ先（採用価格）` and manually entering amount / package
quantity / unit does **not** fetch or calculate any market average. Explicit
`価格を登録・採用` adopts that entered quote on a market-reference offer and
updates the ingredient's shared adopted price. The separate `仕入れ先を追加`
control only links an actual supplier to the ingredient; it does not adopt a
price. The label can mislead operators into assuming a researched market
quote; clarify the UI wording in a separate reviewed change without modifying
the Supplier/Offer/Human Gate contract. See
[`APPROVED_RECIPE_PROCUREMENT.md`](../docs/APPROVED_RECIPE_PROCUREMENT.md).
