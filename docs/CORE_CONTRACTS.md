# Core Contracts — Recipe, Cost, Mutation (v0.3 — review addressed)

**Status: Proposed for implementation; not code.** [MVP](MVP.md) / [Architecture](ARCHITECTURE.md) に従う。Metaモデル・フレームワークに非依存。

## 1. Recipe Data Model

- `Recipe`: `id`, `title` (TrackedValue), `yield_quantity` (TrackedValue), `materials[]`, `steps[]`, `selling_price_jpy` (TrackedValue), `cost_adjustment_jpy` (TrackedValue, default confirmed 0), `revision` (integer), `parent_version_id` (nullable).
- `MaterialLine`: `id`, `material_name` (TrackedValue), `quantity` (TrackedValue), `unit` (string|null), `ingredient_id` (nullable), `price_override` (PriceQuote|null), `price_mode` (inherit | override), `notes`. `material_name` is a recipe-facing name, **not** the purchased product.
- `Ingredient` (minimal optional shared catalog): `id`, `name`, `current_price` (PriceQuote|null). A material may have `ingredient_id=null`; no mandatory master lookup or creation in the conversation.
- `PriceQuote`: `amount_jpy` (TrackedValue), `per_quantity` (positive Decimal string), `per_unit` (string), `source` (manual / estimated / shared-ingredient), `captured_at` (nullable).
- `TrackedValue<T>`: `value` (T|null), `status` (confirmed | assumed | unresolved), `origin` (user | ai | catalog | system), `updated_at`. `unresolved` requires null; `confirmed` and `assumed` require a non-null value. For optional unknown fields, use `TrackedValue(value=null,status=unresolved)` rather than both null and an omitted status. Assumptions never silently become confirmed.

All IDs are stable opaque strings. Monetary and quantity fields use decimal strings internally (not binary floating point). Use explicit `JPY`; selling price must be positive if confirmed or assumed; zero/negative is rejected, and an unknown selling price is explicitly unresolved. Never infer a unit conversion based on ingredient name alone.

**Example**: Material `でんぷん` with `ingredient_id` pointing to shared ingredient `片栗粉`. A price-source change must not overwrite the material's display name.

## 2. Deterministic Cost Calculation

1. Determine effective quote by explicit `price_mode`: `override` requires a line `price_override` and takes precedence; `inherit` reads a linked `Ingredient.current_price`. An unlinked line can use `override` with an assumed quote. **Linking an ingredient does not silently erase or supersede an existing line quote**: the linking operation must explicitly choose inherit or override, otherwise request clarification. UI exposes which source won. Unlinking requires an explicit rule to preserve a quote or mark the price unresolved; never silently reuse a stale catalog quote.
2. A line is computable only if quantity, positive quote denominator, matching/convertible units, and price are available. Negative quantity/price rejected; zero quantity allowed.
3. Unit conversions: same unit; supported fixed conversions for mass (kg/g) and volume (L/ml) only. No conversion between mass and volume, no `個`↔g or `尾`↔g without explicit rate. Unsupported conversion makes the line unresolved, not zero-cost.
4. `line_cost = quantity_in_quote_unit / quote.per_quantity * quote.amount_jpy`. Compute with decimal arithmetic; do not round intermediate line amounts.
5. `subtotal = sum(computable lines)`; `adjusted_subtotal = subtotal + cost_adjustment_jpy` only if the adjustment is valid. If any line or adjustment is unresolved/invalid, expose `partial=true`, `unresolved_line_ids`, and `total_cost_jpy=null`, `cost_rate_pct=null`; present subtotal explicitly as **partial**, never a full recipe cost. A missing quote cannot be zero-filled.
6. When all lines are complete, `total_cost_jpy` = half-up rounded adjusted amount to integer yen. `cost_rate_pct` = total / positive selling price × 100, rounded half-up to one decimal place. These rounding rules are proposed MVP defaults; preserve raw calculation values for diagnosis.
7. If any input was `assumed`, mark computed total/rate as estimate; a deterministic computation does not make assumptions confirmed.
8. A saved version persists a **resolved effective quote for every material** (amount, basis unit/quantity, status, source, linked ID, capture time), recipe state, and calculated output as an immutable snapshot with timestamp/version ID. Shared catalog price changes affect only explicit **current revaluation**, never saved snapshots. Revaluation is an extensibility target, not a mandatory bulk-update feature in MVP.

## 3. AI Mutation Contract

The Meta adapter returns **proposals only**. Proposed envelope:

```json
{
  "recipe_id": "r1",
  "base_revision": 3,
  "operations": [
    {"op": "set_material_quantity", "material_id": "m1", "value": "4", "unit": "尾"}
  ]
}
```

The incoming AI proposal **does not determine confirmation status**. The application binds its source user utterance / approval and assigns `confirmed` only to directly attributable instructions; generated values are `assumed`. If evidence is missing, ask for confirmation. A claimed `origin` or `status` in model output is untrusted and ignored/rejected.

MVP operations: `add_material`, `set_material_quantity`, `set_material_price`, `set_selling_price`, `adjust_cost_adjustment`, `set_cost_adjustment`, `set_title`, `set_steps`, `link_ingredient`, `unlink_ingredient`, `save_version`. Read/retrieve intent is handled separately, never as mutation.

Adjustment semantics: `adjust_cost_adjustment` with signed `delta_jpy` is **relative** to the stored `cost_adjustment_jpy` (e.g. 「概算原価を50円高めにして」→ `+50`; retrying the same mutation must not apply twice; use an idempotent request ID). `set_cost_adjustment` with `value_jpy` is **absolute** (e.g. 「調整額を50円にして」→ `50`). Both modify **only** `cost_adjustment_jpy`; never alter any ingredient or material unit price. The adjustment is a separate cost component, shown independently on screen and in saved snapshots, and does not get distributed across lines. Unresolved adjustment cannot be incremented without a user-confirmed base. Negative adjustment is permitted only if the resulting full cost is nonnegative; reject otherwise. Preserve status provenance from user evidence just like other mutations. Examples: initial 0 + 50 → 50; current 50 + 50 → 100; set to 50 → 50 regardless of previous value. Replayed request IDs do not repeat a relative delta.

Apply pipeline: parse as schema → reject unknown operation/fields and invalid Decimal/units → verify recipe and exact line IDs → verify `base_revision` (stale proposals rejected) → check status/origin evidence and price-source rules → prepare all operations on a copy → recalculate and validate derived state → atomically persist recipe and revision (and snapshot when requested) in one transaction only if **every operation** validates. A persistence failure must leave both state and revision unchanged. A failed batch changes nothing.

A bare model assertion that a value is `confirmed` is insufficient. `confirmed` is allowed only where the application can attribute it to an explicit user instruction or approval; reject silent promotion. Ambiguous references are returned as clarification candidates, never guessed and applied.

## 4. Acceptance tests to implement in P2

1. `海老3尾` confirmed quantity + assumed price: estimated total, not confirmed.
2. At 150円/尾, compare 3尾 (=450円) and 4尾 (=600円) with identical other inputs: exactly 150円 difference. Also test the separate operation changing a previously assumed price to 150円/尾.
3. Recipe-facing material `でんぷん` linked to `片栗粉`: display name stays unchanged.
4. Linked shared ingredient: explicit current-price revaluation uses new price; saved snapshots remain unchanged. Multi-recipe bulk propagation remains outside MVP.
5. Null ingredient link: estimate and save with independent price quote.
6. `override` takes precedence, `inherit` follows current catalog quote; linking with an existing override must choose explicitly; unlinking must not silently retain stale catalog prices.
7. kg→g works; piece→g without conversion fails safely and returns partial total.
8. Missing price/adjustment produces partial result with null full total/rate; invalid selling price is rejected; unresolved selling price yields null rate.
9. Stale revision, wrong material ID, unsupported op, partial batch failure: no state mutation.
10. Spoofed `confirmed`/`origin` from AI is rejected; user-evidence-bound update is confirmed; inferred values remain assumed.
11. Separate saved version preserves original, effective quote and provenance even after shared catalog price changes.
12. Persist/transaction fails during a batch or version save: original state and revision remain unchanged.
13. From initial adjustment 0, `adjust_cost_adjustment(+50)` makes 50, repeated distinct user instruction makes 100, but retried identical request ID remains 50. `set_cost_adjustment(50)` produces 50 regardless of previous adjustment; ingredient unit prices unchanged.
14. An unresolved adjustment cannot be incremented without resolving its baseline; invalid negative resulting total is rejected.

## 5. Decisions deferred before implementation

- Python package, web and DB libraries, deployment and microphone path
- Shared-catalog administration UI and bulk price-update UX (not required for MVP)
- Cross-unit domain conversions when requested by user
- Storage schema migration and concurrent editor synchronization

The feature implementation deadline / hackathon operational timeline is managed in Notion, not this product contract.

## 6. Self-review record (2026-10-27)

- **P1 fixed:** Model-supplied `confirmed` was forgeable; confirmation now bound by app to user evidence.
- **P1 fixed:** Implicit quote precedence could prevent catalog price revaluation; explicit inherit/override and link/unlink behavior required.
- **P1 fixed:** Incomplete inputs could appear as full totals; full total and rate now null for partial costs.
- **P1 fixed:** Unit test wording mixed quantity and price changes; assertions now use fixed 150円/尾 basis.
- **P1 fixed:** Atomicity needed to include recalculation, revision, and persistence; no commit before validation.
- **P2 open:** Exact storage schema, framework/deployment, voice integration and UX require implementation decisions and tests. No runtime verification has been performed.

## 7. External review response (2026-10-27)

- **Codex P2 addressed:** README's “Increase the estimated total cost by 50 yen” could not be represented by the previous allowed operations. Added relative `adjust_cost_adjustment` and absolute `set_cost_adjustment`, provenance, idempotency, and acceptance cases. These apply only to the explicit cost adjustment field, not material unit prices.
