# Web voice acceptance — 2026-10-29

## Scope and result

The hackathon submission is a **Web application**. A native application and
physical smartphone testing are not deliverables or completion gates for this
change. The audio boundary only anticipates possible future inputs.

The local Web application passed a live end-to-end test using actual Muse
Voice Transcribe, Muse Spark and dedicated Chef Supabase. No provider response
or database was substituted in that test. No production deployment or merge
was performed.

The microphone input was Japanese speech synthesized locally with Windows'
Microsoft Ayumi voice, played into a real Chromium Web Audio stream. Actual
AudioWorklet capture, WAV resampling, same-origin API calls, transcription,
interpretation, Human Gate, database persistence and reload ran. This establishes
the integration; it does not establish physical microphone quality, general
speaker accuracy, kitchen noise robustness or smartphone compatibility.

## Observations and fixes

1. Live Voice accepted the documented WAV/multipart/Bearer contract. Direct
   Japanese clips took approximately 1.0–4.2 seconds per provider request;
   recording time, 3.5-second local silence detection and Spark parsing are
   additional latency. These few measurements are not a benchmark or SLA.
2. Without vocabulary hints, examples included `売価` → `倍価` and
   `乾燥パスタ` → `炭素パスタ`. Official Japanese culinary `keywords` improved
   these clips. The raw transcript remains visible; no silent replacement was
   added. Recipe-title recognition still varied.
3. Live Spark returned `notes: ""`, which the existing validator correctly
   rejected. The prompt now explicitly requires an array and gives the empty
   shape. The validator was not relaxed; a regression test retains rejection
   of the observed wrong type.
4. The chef's next audio turn explicitly corrected the title to `音声テスト`
   and pasta quantity to `150g`. This updated the visible unsaved draft.
5. A repeat run recognized the purchase price ambiguously as `三百百五十円`.
   Spark surfaced a note and missing price; review/save remained blocked and
   no rows were written. A subsequent full run recognized the same clips
   correctly and passed entirely by voice. The opt-in test also supports the
   existing explicit typed-correction/re-review/button-approval recovery if
   needed; it logs when used and never silently fixes recognized values.

## Verified live sequence

- Dictate `recipe.wav`: pasta 100g, purchase price JPY350 per 500g, sale JPY1800.
- Before review: zero recipes, zero versions; save button disabled.
- Dictate `correction.wav`: title `音声テスト`, quantity 150g.
- Still zero persisted recipes before approval.
- Dictate `review.wav` (`内容を確認`): save becomes available, still zero writes.
- Dictate `save.wav` (`登録を確定`): one recipe and one initial version persisted.
- Database state: title `音声テスト`, quantity 150g, sale JPY1800, cost JPY105,
  cost rate 5.8%, revision 0.
- Reload the Web application: one recipe remains visible with cost JPY105.
- Stop the test backend: delete only the fresh test owner. Verify zero rows for
  that owner in recipes, versions, receipts, ingredients, images and correction
  preferences, and no temporary test Auth owner remains.

The dedicated project is `dfvryaybdelgjxihdmth`. Restaurant operations project
`jfaxjgvqfsacprenodkg` was not accessed. This service-role acceptance test is
not an RLS isolation test; it verifies the protected demo's persistence path.

Independent read-only review of application changes and the live harness found
no confirmed bugs or approval/auth bypass. Fixture tests separately cover
transcription failures, cross-origin/anonymous requests, size/format rejection,
microphone switching and cancellation.

Final local validation: 13 ordinary browser tests passed (2 live cases skipped
by default); the Voice/Spark/Supabase case passed separately with explicit
opt-in. Python: 117 passed, 1 live-only case skipped. Production Web build and
TypeScript checking passed. Test owners were removed and all six owner-scoped
table counts verified zero after the successful runs.

## Reproduce explicitly

Never run this automatically in CI or against a production/demo owner's data.
Use the existing server secret-loading mechanism; do not copy keys into test
source, audio, logs or committed environment files.

1. In a private server process, load the existing `MODEL_API_KEY`,
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for the dedicated Chef project.
   With API dependencies installed, run from the repository root:

   ```sh
   CHEF_LIVE_VOICE=1 python tests/live_voice_backend.py
   ```

   This checks cleanup-query compatibility first, creates a fresh test owner,
   prints its non-secret ID for recovery, and binds only to loopback `:8102`.
   It is a test harness and must not be deployed as an application entrypoint.

2. Supply four canonical mono PCM16 24kHz WAVs in a private test directory:
   `recipe.wav`, `correction.wav`, `review.wav`, `save.wav`. Use the sequence
   above. The correction explicitly names the title `音声テスト`. Each clip
   must be under 29 seconds; do not include secrets or personal information.

3. In a second private process, load only the server's `MODEL_API_KEY`. From
   `web/`, after `npm run build`, run:

   ```sh
   CHEF_LIVE_VOICE=1 CHEF_LIVE_VOICE_AUDIO_DIR=/absolute/audio/path npx playwright test --config playwright.live-voice.config.ts
   ```

   The Web server binds `:3102`; its test-only access credentials match the
   loopback harness. The test logs only the supplied synthetic transcript and
   derived cost. Default `npm test` skips this live case.

4. Even on test failure, POST to `http://127.0.0.1:8102/test/stop` and wait for
   backend exit code 0 and six zero cleanup counts. Do not hard-kill the
   process. If interrupted before cleanup, use the printed test-owner UUID to
   inspect/delete only that owner through the existing trusted admin path,
   then verify its six owner-scoped tables are empty before starting again.

## User's next step

No setup, API-key replacement or smartphone preparation is required to review
this change. PR #48 contains the implementation, tests and evidence. The
current hosted application remains unchanged. Merge and deployment require an
explicit user instruction under the task's original release restriction.
