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
- **Edit / 編集**: on the home screen, select 編集 first, search/select the
  target recipe, and verify that its detail route opened in 編集 mode. Saying
  “〇〇のレシピを編集して” follows the same route; one match opens directly,
  while multiple matches show selectable results. On an already-open detail,
  the edit button starts edit mode for that recipe. Dictate changes only after
  checking the displayed mode and target, inspect the proposal and before/after
  diff, then explicitly approve before the existing
  `/api/recipes/{id}/confirm` write.

This is an **operating sequence, not a new hard enforcement rule**. Existing
backward-compatible direct dictation from idle may still enter create mode;
queued voice data is not intentionally discarded merely because it started
before the transition cue. Approval requests captured before the current
review/mode are still rejected, and pending edits cannot silently be dropped
by switching tasks. Do not confuse mode confirmation with permission to save.

**Manual recipe entry** is separately available in the home recipe library:
type a recipe name and create it, then edit its materials in the detail view.
The mode buttons do not themselves implement a manual ingredient form.

**Procurement UI:** the ingredient editor has one supplier selector. To record
and adopt a purchase price, choose the supplier (including the abstract
`相場参考価格` supplier), enter amount, purchase quantity and unit, then use
`価格を登録・採用` and confirm. A supplier is therefore linked through its
approved Offer and price history; the former price-free “add/link supplier”
control is removed. Choosing `相場参考価格` does not fetch or calculate a
market average. See
[`APPROVED_RECIPE_PROCUREMENT.md`](../docs/APPROVED_RECIPE_PROCUREMENT.md).

## Edit proposal confirmation

In edit mode, describing a change automatically opens the confirmation dialog.
Review before/after changes and the projected ingredient composition. Added rows
are highlighted; removed rows are named explicitly. Approve using the existing
checkbox and save button, or say “承認”, “更新して”, or “保存して” after the
current proposal is displayed. The dialog's microphone button controls the same
Workspace capture. Back/Escape retains the proposal and clears approval; no save
is performed by opening or closing the dialog. Uncertain saves retain the same
request ID for retry. Real kitchen audio/provider behavior remains a separate
acceptance check from fixture tests.

Regression: `node --test tests/edit-preview.node.cjs` and
`npx playwright test tests/edit-preview.spec.ts`.

## Voice recovery and scheduled research

Voice drafts continue when the unit catalog is temporarily unavailable; retry the
catalog before approving a formal save. Failed analysis retains unprocessed speech
on this device, including across reload, and offers an explicit analysis retry.

Scheduled research is initially OFF globally and per ingredient. Configure the
interval in Settings → Scheduled price research, and enable individual ingredients
in their create/edit forms. Results stay unadopted until the chef reviews the source,
package quantity/unit, tax and shipping and explicitly adopts a candidate. The bell
links to pending candidates. Adoption updates the existing shared/adopted-offer cost
path; other suppliers and purchase conditions keep their own approved prices.

Database migration, scheduler activation, deployment protection, verification and
production limitations: [ADR-016](../docs/ADR_016_SCHEDULED_PRICE_RESEARCH.md).


## 音声レシピの保存確認（2026-11-05）

1. 登録モードで料理名・材料・数量を話す。訂正・メーカー・仕入先の追加は同じ下書きへ反映する。
2. 「全部の平均価格を調べて」などで全対象の調査を開始。検索中も訂正でき、結果と失敗は行ごとに表示される。出典と購入単位は価格詳細で確認する。
3. 最初の「保存」でマスター照合結果を表示する。数量・価格・再利用食材・新規食材・単位・仕入先と、共通採用価格への変更を確認する。
4. その後にもう一度「保存」または「承認して保存」で登録する。確認前の録音・未解析の追加入力は承認にならない。価格不明は未確定として保存する。
5. 保存後の詳細表示と再読込で内容を確認する。

実行手順・実APIの検証範囲は `docs/VOICE_RECIPE_ACCEPTANCE.md` を参照。

## 食材編集の統合保存

食材マスターで名前・規格・仕入先・価格・購入数量/単位・定期調査を編集し「保存」を押す。価格または購入条件を変えた場合は確認画面で「承認して保存」。価格を変更しない場合は確認画面も価格履歴追加もない。価格未設定の食材も保存できる。

単位はDBの単位マスターから選ぶ。必要な単位がなければ編集内のリンクから既存の単位管理で登録・承認し、「単位一覧を更新」で戻す。自動換算は行わない。

失敗時は具体的なエラーを表示して入力を保持する。通信・DB保存を確認できない場合は同じ内容で再試行すると同じ保存IDを再使用し、二重の価格履歴を防ぐ。別仕入先の価格比較は維持する。保存・再読み込み後も選択した購入条件を表示する。

この変更にはDB移行が必要（冒頭の旧UI変更の「移行不要」とは別）。契約と検証手順は [ADR-017](../docs/ADR_017_INGREDIENT_ATOMIC_EDIT.md)。本番適用はレビュー・マージとは別途行う。

通信エラー後に価格や仕入先を変更して保存する場合は、まず前の承認保存を同じIDで再照合し、DBの最新状態を確認する。その間も入力は保持する。前の保存が成功していれば、その状態に対する変更として確認画面を表示するため、元の価格・仕入先へ戻す操作も反映される。前の結果を確認できない場合は、新しい保存を進めず再試行を案内する。

## レシピと食材マスターの連動

登録の確認画面では全食材の新規/再利用と件数を確認する。類似名・複数規格の候補がある場合は既存マスター、または別商品として新規登録（必要な規格も入力）を選び「選択して再照合」。表示後に改めて承認して保存する。確認画面が出る前の保存発話だけでは承認しない。

保存済みレシピの鉛筆ボタンから名前、使用量、仕入先、購入条件、価格を編集できる。変更して保存→マスターと仕入条件の確認→承認して保存。同じ購入条件を参照する別レシピの現在原価も更新され、別仕入先・別条件・過去の保存版は変わらない。レシピの使用量はそのレシピ固有である。

「食材を追加」は価格未確定でも利用できる。価格を入力するときは購入数量・単位も指定する。単位マスターを取得できない場合は理由が表示される。設定の「食材マスター」で新規登録した食材も検索できる。見つからないときは「絞り込みを解除」で仕入先フィルターと検索を戻して確認する。

現行スキーマを必須とし、先行移行と [ADR-018](../docs/ADR_018_RECIPE_MASTER_PROCUREMENT.md) の移行が必要。本番適用と公開環境での動作確認は別途行う。
