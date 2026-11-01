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
