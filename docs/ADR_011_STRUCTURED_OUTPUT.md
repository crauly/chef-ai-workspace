# ADR-011: Muse Spark Structured Output (JSON Schema)

## Status
Accepted (Phase C). Chat Completions verified surface; Responses unverified.
Voice-recipe schema live acceptance recorded 2026-10-31 (opt-in).

## Context
Phase C moves Muse Spark 1.3 natural-language understanding to JSON Schema
Structured Output for intent classification and recipe structuring, without
changing the voice harness, draft, approval, or save contracts.

## Decision
- SSOT: `web/muse-schemas.ts` (`INTENT_SCHEMA`, `VOICE_RECIPE_SCHEMA` incl. optional-on-the-wire `price_research` for explicit ledger-grounded price research and `name_corrections` for chef-selectable ingredient-name candidates),
  `chatResponseFormat()`). Schemas mirror the app-side validators in
  `web/app/api/intent/route.ts` and `web/app/api/voice-recipe/route.ts`.
- Chat Completions (`/v1/chat/completions`) sends
  `response_format: {type: "json_schema", json_schema: {name, strict: true, schema}}`.
  This is the only structured-output parameter emitted in this change.
- Responses API (`/v1/responses`, Python `meta_responses.py`) sends NO
  `text.format` / `response_format`: the shape is unverified against a live
  Responses acceptance, and §2 forbids unconfirmed parameters. Instructions +
  strict local `parse_response` remain the contract there.
- Structured Output guarantees shape only. All semantic checks stay app-side:
  schema validation, unit/decimal checks, package-vs-use distinction
  (e.g. 100g used vs 500g pack at 350yen), owner separation, revision/CAS,
  idempotency, explicit user approval, canonical save API only. An AI-emitted
  approval flag never authorizes persistence.
- Fail closed: non-stop finish_reason, refusals, interruptions, API errors,
  and schema/shape violations return 502 with no partial save and no draft
  destruction; no unbounded retry; no second independent JSON interpretation
  path.

## Live acceptance (2026-10-31, opt-in `CHEF_LIVE_STRUCTURED=1`)
- Intent schema: accepted, `finish_reason=stop`, conformant `{intent, target}`.
  A 256-token budget truncated under reasoning load (`length`); 2048
  (production value) succeeds.
- `VOICE_RECIPE_SCHEMA` verbatim shape: accepted, `stop`, top-level keys,
  nested `materials` (6 string fields), `interpretations`, and key values
  (quantity 100 vs price_quantity 500) verified against the live response.
  Scope note: the live probe asserts structure and key values only; it does
  NOT execute the real app-side `parse()` (TypeScript). `parse()` equivalence
  rests on the shared shape gate, covered by the fixture spec
  (`web/tests/structured-output.spec.ts`) which runs `parse()` directly, plus
  the offline parity test below that pins the probe schema to the SSOT.
  First probe returned unit `"grams"`: the minimal probe prompt lacked the
  production "Allowed units" constraint, and the app-side value gate
  (missing[], never silent accept) is the designed backstop. With the
  production constraint mirrored, units conform.
- `tests/test_structured_output_contract.py::SchemaParityTests` (offline)
  serializes the real `web/muse-schemas.ts` with the existing dependency-free
  Node runtime and deep-compares the entire `VOICE_RECIPE_SCHEMA` structure:
  field types, `required`, array `items`, nesting and `additionalProperties`.
  Intent is covered by required/enum checks only, not a deep compare. If Node
  is unavailable the deep check skips with a reason instead of passing blind.
  This prevents the live test from passing against a stale schema; it does not
  execute `parse()` and does not prove model output semantics beyond the
  probed values.
- No DB write, no approval, no persistence in either probe.

## Language policy (voice-recipe prompt)
English primary, Japanese fully supported, cuisine-agnostic. The prompt
keeps all material/quantity/price interpretation constraints (package vs
use, decimal strings, no invented prices, no unit conversion) and no
longer singles out any cuisine in dish-title normalization examples.

## Consequences
- Intent + voice-recipe gain schema-enforced shape with identical downstream
  Human Gate behavior (reviewEpoch/approvalEpoch, explicit confirm).
- Responses propose/axis paths unchanged until a live `text.format`
  acceptance is recorded; that acceptance must update this ADR first.
- Name correction signal: `name_corrections: [{material_name, heard, candidates[{name, reason}]}]` (1-3 candidates, never padded; entry omitted when confident). Informational only: draft keeps a single name, candidates are never auto-applied, and saving is never blocked. Brand/maker names are never rewritten into other products.
- External web reference: live retrieval runs on Meta Search Grounding ONLY
  (Responses API `web_search` on muse-spark-1.3; no Tavily/Brave/Exa/Google).
  `web/price-web-search.ts` calls the Responses endpoint with
  `tools: [{type: "web_search", search_context_size: "low"}]` (context size
  lives INSIDE the tool object; a top-level value is rejected with 400).
  Search evidence requires an observed `web_search_call` plus source
  evidence: `url_citation` annotations when present, or per-candidate
  source URLs actually returned by the model (verified live 2026-11-01:
  completed responses carried `web_search_call` items with zero
  `url_citation` annotations while candidates cited their own page URLs).
  Tool-request-only, citation-free prose, or unparsable payloads are
  "not searched" and never become prices. JSON-only instructions suppress
  annotations, so the call asks for one prose bullet per candidate after
  the JSON plus a `url` field on every candidate to carry the sources.
  First verified live 2026-11-01: status completed, 5 web_search_call
  (search + open_page), 6 url_citation annotations, 3 JPY candidates
  (500g packs 920/1080/1200 yen with source URLs) all passing the shared
  validation. The route tries the owned ledger
  first and only falls back to grounding per entry (max 3); ledger hits
  never search, and any grounding failure keeps the ledger entry -- the
  draft never fails and nothing is auto-saved. `external_reference.py`
  keeps the provider contract and `price_web_search.py` mirrors the
  response parsing; sample references are labelled by sample count and
  never claimed as a general market average; incomparable candidates are
  excluded, never mixed. `price_references` entries carry
  `origin: "ledger" | "external"`, external ones additionally
  `sources: [{url, title}]` + `fetched_at` (UI-safe: the existing card
  renders `text` only). Validation rejects non-finite decimals (NaN,
  Infinity) row-wise on both runtimes without aborting. Each sample keeps
  its own url/fetched_at/tax/shipping provenance (never backfilled); the
  Python summary labels computation time `aggregated_at` so old listings
  are never relabelled as fetched now. No EC-specific code, no fabricated
  prices, no model-knowledge fill.
- Price research signal: `price_research: [{material_name, request, material_index?}]` records the chef's explicit request only (調べる/平均/参考/最安 wording, never 「その価格を使って」, which is applying a shown candidate, not researching); the route resolves it against the owned ledger (`GET /demo/price-reference`, read-only) and reports back in the non-blocking `price_references` response field (never `notes`, so the save gate is untouched). `material_index` (0-based into materials[]) is the canonical row key: each entry resolves to it once (an exact row-name match beats a contradictory in-range index, else a valid Muse index wins over a drifted name, else rowless -1), and `research_status[]`/`provisional_prices[]` carry it, so a searched product wording that drifts from the row name still binds the right row. Provisional entries are labeled with the ROW name; the searched name survives in references/status only, and candidate product names never rewrite draft rows. Rowless entries are still searched by name but bind no provisional. Non-JPY references keep their currency verbatim; candidate selection prefers exact-name available history and names any non-exact fallback explicitly. Prices stay empty (missing path); enrichment failure never fails the draft. Lookup failures are reported distinctly from genuine no-history (`status: unavailable | unauthorized | invalid_response` vs `none`) with non-secret Japanese text, so a backend/auth outage is never disguised as "no history". No web retrieval exists, so model-knowledge prices stay forbidden. Comparable web samples are averaged with the cheapest comparable sample first; incomparable rows are excluded, never mixed.
- Tests: `web/tests/structured-output.spec.ts` (fixture, no key),
  `tests/test_structured_output_contract.py` (contract pin).
  `web/tests/price-web-search.spec.ts` (fixture: evidence gating,
  ledger-first fallback, real-shape parse),
  `tests/test_price_grounding.py` (fixture: parse + contract),
  `tests/test_price_grounding_live.py` (opt-in `CHEF_LIVE_GROUNDING=1`:
  one low-context search asserting `web_search_call` + (`url_citation`
  OR candidate-carried source URLs) + priced candidates; read-only,
  no DB).

## Deferred price enrichment (latency split)
Accepted. `/api/voice-recipe` used to hold the draft until ledger
lookups (15s timeout each, sequential, up to 3 entries) and Search
Grounding (45s timeout each, sequential, up to 3) all finished -- up to
~180s of price phase blocking the draft after the Muse call (25s
timeout). Two changes, no new job infra, no new external service:
- Entries now enrich concurrently (`Promise.all`, cap 3 bounds the
  fan-out; result order follows entry order, never completion order).
  Ledger-first per entry, validation, row binding, and Human Gate are
  unchanged.
- `defer_prices: true` returns the parsed draft right after Muse with
  `research_state: "deferred"`, `pending_research[]` (検索待ち per row:
  material_name/material_index/request/trigger), and empty
  price_references/research_status/provisional_prices. The UI then calls
  stateless `POST /api/voice-recipe/prices` with the CURRENT materials
  snapshot; every entry is re-bound there against those fresh rows, so a
  stale index can never attach a price to the wrong row (検索中 is the
  in-flight prices call client-side; 完了/失敗 arrive per entry via the
  existing research_status ledger/web states). Default responses carry
  `research_state: "complete"` and are otherwise shape-compatible.
- Shared SSOT: `web/price-enrichment.ts` (row binding, lookup, selection,
  provisional shaping, entry assembly, parallel enrich). Both routes
  import it; no duplicated binding logic.
- Fixture proof: `web/tests/voice-recipe-deferred.spec.ts` (deferred
  makes zero ledger/grounding calls; 400ms+400ms mocked enrichment
  measured deferred=3ms vs full=813ms; out-of-order latency keeps entry
  order; contradictory/stale indexes never misbind; bad shapes fail
  closed). Production wall-clock gains vary by backend/search latency.

## Deferred row identity (P2 fix)
`pending_research[]` carries `row_name` (the materials[] row name the
entry was bound against, null when rowless) alongside `material_index`.
`POST /api/voice-recipe/prices` accepts entries with `material_index: -1`
(this API's own rowless marker; null/omitted also rowless) and an optional
`row_name`, and binds via `bindRow` (`web/price-enrichment.ts`): a pointer
is honored only while the current row still carries its creation name, so
a deletion/reorder/rename that moves another ingredient under the old
number discards the pointer and falls back to an exact searched-name
match, else rowless (searched by name, never bound). Without a row_name
the historical rule applies. A rowless AVAILABLE price binds nowhere, and
one entry's failure never fails the others. Fixture proof:
`web/tests/voice-recipe-deferred.spec.ts` (mixed rowless/healthy,
deletion/reorder/rename/drift, bad row_name and out-of-shape indexes fail
closed).

## Price-search lifecycle across follow-up utterances (P0 fix)
Accepted. `VoiceRecipeRegistration.enqueue()` used to abort the running
`POST /api/voice-recipe/prices` call on every new data utterance, so
continuous speech always cancelled the search (`(canceled)` in
production) and the reference price never arrived. The abort is removed,
not merely deleted: a `priceFlight` ref (pending signature +
creation row names) tracks the running search, and a finished-signature
set suppresses duplicate calls for the same ingredient + request.
- Unchanged rows: when the next parsed draft's `pending_research`
  signature matches the flight and every in-flight row still exists at
  the same index with the same name, the flight is rebased onto the new
  draft and the single running request is kept (no second fetch); its
  result merges onto the LATEST draft only if those rows are still
  unchanged, otherwise it is discarded, never misapplied.
- Changed rows (rename/reorder/delete/new request): the stale flight is
  aborted and a fresh search starts for the new condition only.
- Review/save are no longer blocked while searching: merging a price
  result resets the review snapshot (`reviewed=null`, stage back to
  dictating), so a search that lands after review can never be committed
  under the old approval; merging is skipped while saving. Draft status
  is always one of 価格を検索しています / 検索結果を取得しました /
  価格を確認できませんでした (compact `role=status` line, per-row 検索中
  kept), and failure keeps the draft with the loading flag cleared, so no
  stuck "searching" remains. Internal terms (provisional/deferred/
  pending) stay out of user-facing text.
- Fixture proof: `web/tests/voice-price-lifecycle.spec.ts` (carry-over
  with exactly 1 prices call, rename restarts without stale binding,
  failure keeps draft and clears searching, bottom-mic recording state).

## Price-search lifecycle follow-ups (PR #100 review)
Three completions to the flight model, same guarantees (row identity,
Human Gate, no misbinding):
- Empty follow-up pending terminates the old flight: a parse result with
  no `pending_research` aborts any running search and drops its stash, so
  unneeded prices can never land and loading never sticks.
- Discarding the draft resets search history: `clear()` and successful
  save clear `priceDoneKeys` (plus flight/stash/loading), so the same
  ingredient in a fresh registration is searched again.
- Search finishing mid-parse is stashed, not lost: when the prices
  response arrives while no live draft exists (a follow-up parse is in
  flight), it is kept with its key/rows and applied by the completing
  parse without refetching (exactly one prices call); a stale stash never
  overwrites a changed draft, and a parse failure adopts a matching stash
  onto the kept draft instead of stranding it.
- Fixture proof: three added cases in
  `web/tests/voice-price-lifecycle.spec.ts` (empty-pending termination,
  discard-then-research, mid-parse completion without refetch).

## Review follow-ups: result reuse and failure invalidation (PR #100)
Two P2 findings on the flight model, fixed without touching row
identity or the Human Gate:
- Completed searches are cached per full key (entries signature + row
  names) and reapplied to an identical repeated request, so a repeat is
  served with zero fetches and no row is ever left pending with no
  flight. Renamed/reordered rows miss the cache and search fresh; the
  cache is cleared on discard/save alongside flight state.
- The price-failure fallback now invalidates the review snapshot
  (`reviewed=null`, back to dictating), exactly like the success path,
  so an approval taken mid-search cannot linger enabled-yet-dead.
- Fixture proof: two added cases in
  `web/tests/voice-price-lifecycle.spec.ts` (identical-repeat reuse with
  one fetch, review-invalidated-on-failure).


## 2026-11-05 音声下書き・全件価格調査・登録確認（本節が旧件数制限に優先）

- 下書き解析はマスター検索に依存しない。単位カタログや台帳障害でも、型付きの未確定値を含む下書きを表示する。正式照合は保存指示時に行う。
- Museは共通20秒の予算内で呼ぶ。通信・タイムアウトを自動再試行しない。不正な構造だけ一度再生成でき、同じ予算を共有する。元の発話と正常な下書きは保持し、未解析発話がある間は承認保存しない。
- 完成した先行応答を差分解析baseにできる。後続発話の解析はその後の差分だけを送り、原文は省略せず端末に保持する。先行表示は承認対象ではない。
- 価格依頼の3件切り捨てを撤廃。フォームの全40行まで対象にできる。Sparkが「全部」「このキノコ全部」「価格がないもの」「一つずつ」や誤認識を文脈解釈して対象行を列挙する。補助検出はカテゴリ依頼を全食材へ拡大しない。不明な対象は確認し、別食材の価格を充てない。
- 画面は一つの依頼を2件ずつ検索し、各バッチの結果・失敗を逐次表示する。1バッチ失敗でも後続を継続。共通enrichmentは最大3並列のworkerで全エントリを処理し、件数で切らない。台帳参照は3秒、外部検索は45秒の上限。台帳は一致名または明示IDに限定し、別食材の履歴を仮価格として採用しない。
- Meta Groundingは1〜3候補に絞り、検索中の逐次説明を抑え、出力上限4096。実検索で2048上限による `incomplete/max_output_tokens` を再現したため拡大した。不完全応答は成功扱いしない。出典・購入数量・単位の検証とLedger-firstを維持する。
- 数量訂正は価格検索と並行できる。名称と仕入先を価格検索の同一性に含め、変更前の検索結果を変更後へ適用しない。未完了の依頼はSparkへ文脈として渡し、改名時は訂正後の行へ移す。
- 最初の保存指示は読取専用 `/demo/recipes/full/review` で既存の正式保存と同じ検証・所有者別食材照合・単位正規化・仕入先重複確認を実行する。再利用／新規作成と採用価格変更を表示する。標準単位の次元は安全な既知分類を候補に使えるが、作成は承認後だけ。
- 次の明示保存指示（音声の既存epoch検証を含む）または承認ボタンで、既存 `/demo/recipes/full` の原子的レシピ・Ingredient・Unit・Supplier・Offer登録へ進む。確認中の訂正・価格結果到着は承認を無効にする。未知価格はnull、架空価格やゼロで補完しない。コミット時も再照合し、競合・曖昧な重複を拒否する。
- 実機・本番とローカルの検証範囲は `docs/VOICE_RECIPE_ACCEPTANCE.md` に分けて記録する。

### PR #139 レビュー後の確認・復旧条件

- 「しめじとえのきの価格を全部」のような名前付き依頼は、その行だけを補助検出する。明示的な「全食材／レシピ全体」は全行、それ以外の裸の「全部」は名前付き対象がない場合だけ全体へ広げる。価格既知の名前付き対象から、別の未価格行へ依頼を転用しない。
- 下書き訂正が既存の価格一式を空にした場合、過去の候補を自動再適用しない。候補自体は価格詳細と明示的な再採用用に保持できる。
- 確認APIへ送る内容を登録IDに結び付け、単位分類の変更によるID無効化も応答適用条件に含める。確認した内容そのものを保存へ送り、保存直前に別の内容へ組み直さない。
- 応答消失への再送のため、登録IDと正確な送信内容（新規単位候補も含む）を端末に保持する。再読込後も承認は復元せず、確認・明示承認を再度要求する。サーバーは既存IDの作成内容を照合し、一致時は保存済み確認として提示できる。不一致は409、再送は既存の冪等経路を使い二重登録しない。
- 価格競合の同一性は食材・仕入先・購入数量・正規単位で判定する。500gパックと1kgパックは既存RPCと同じく別条件として扱い、同じ購入条件に異なる金額を同時指定した場合だけ拒否する。

## 音声の部分欠落検証（2026-11-05）

音声レシピの出力に `material_changes` を追加。後続解析で以前の行が消えた場合は、remove/rename宣言と改名先の存在をハーネスで検証し、未宣言の欠落を正常JSONとして採用しない。写真取り込みの契約は `IMAGE_RECIPE_SCHEMA` として以前の構造を維持する。Pythonの実モデル検証用ミラーも音声スキーマに一致させる。詳細は [ADR-018](ADR_018_RECIPE_MASTER_PROCUREMENT.md)。

## 登録入力契約の修正（2026-11-05）

下書きとfull保存を、名前/仕入先200文字、数値文字列30文字、単位32文字、非負の使用量/価格、正の価格基準数量/売価に統一する。全角・前後空白・正しい3桁区切り・冗長なゼロは値を変えず正規化する。非有限値、DB numericの範囲外、長すぎる数値は有効値として送らない。任意の不正/不完全な項目は下書きに保持し、フィールド別理由を示してNULLへ投影する。必須の料理名・食材名や構造が不正なら422で修正を求める。

使用数量と使用単位、仕入価格・基準数量・価格単位はそれぞれ独立した組である。使用量がNULLでも、完全な既知の仕入価格は既存の正式な採用経路で保存する。価格の一部しか分からない場合は従来どおり3項目ともNULLであり、ゼロを補わない。新規単位は分類が提示され承認されたものだけ正式保存する。

推定値のフィールド別provenanceを現行下書きで保持できないため、推定した値は事実欄に埋めずinterpretationsに候補・根拠を出す。事実欄は未確定のまま、明示承認まではconfirmedにしない。未確定の保存値は既存モデルのunresolved/null、ユーザーが承認した既知値はconfirmedとなる。構造修復は既存の合計2試行（再生成1回）と時間予算内に限定し、問題フィールドを渡す。修復で既知の正常値が変更された結果は拒否する。

full/review・fullの422は安全なフィールドパスと理由をプロキシから画面へ渡す。409競合、503障害、通信失敗による結果未確認を区別し、下書きと同じ保存IDを保持する。確認失敗を理由に正常値や既存下書きを初期化しない。

検証は対象のみ：保存APIの既存＋追加15件、正規化/修復/投影/安全なエラー伝達のNode15件、既存音声登録の画面1件、型チェック・その画面テストに必要な本番ビルド。外部AI・本番DB・移行は実行しない。

写真取り込みでは、メモの出典照合が完了するまで数値の元表記を保持し、照合後の最終parseで正規化する。NFKC化した食材名と `name_corrections.material_name` は同じ表記へ揃え、聞き取った原文や候補名自体は書き換えない。
