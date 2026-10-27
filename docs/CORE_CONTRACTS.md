# Core Contracts — Recipe, Cost, Mutation (v0.1)

**Status: Proposed for implementation; not code.** [MVP](MVP.md) / [Architecture](ARCHITECTURE.md) に従う。Metaモデル・フレームワークに非依存。

## 1. Recipe Data Model

- `Recipe`: `id`, `title` (TrackedValue), `yield_quantity` (TrackedValue|null), `materials[]`, `steps[]`, `selling_price_jpy` (TrackedValue|null), `cost_adjustment_jpy` (TrackedValue, default confirmed 0), `revision` (integer), `parent_version_id` (nullable).
- `MaterialLine`: `id`, `material_name` (TrackedValue), `quantity` (TrackedValue|null), `unit` (string|null), `ingredient_id` (nullable), `price_override` (PriceQuote|null), `notes`. `material_name` is a recipe-facing name, **not** the purchased product.
- `Ingredient` (minimal optional shared catalog): `id`, `name`, `current_price` (PriceQuote|null). A material may have `ingredient_id=null`; no mandatory master lookup or creation in the conversation.
- `PriceQuote`: `amount_jpy` (TrackedValue), `per_quantity` (positive Decimal string), `per_unit` (string), `source` (manual / estimated / shared-ingredient), `captured_at` (nullable).
- `TrackedValue<T>`: `value` (T|null), `status` (confirmed | assumed | unresolved), `origin` (user | ai | catalog | system), `updated_at`. `unresolved` requires null; assumptions never silently become confirmed.

All IDs are stable opaque strings. Monetary and quantity fields use decimal strings internally (not binary floating point). Use explicit `JPY`; selling price of zero is invalid for a percentage but can be represented as unresolved. Never infer a unit conversion based on ingredient name alone.

**Example**: Material `でんぷん` with `ingredient_id` pointing to shared ingredient `片栗粉`. A price-source change must not overwrite the material's display name.

## 2. Deterministic Cost Calculation

1. Determine effective quote: explicit line `price_override` wins; otherwise use linked `Ingredient.current_price`; otherwise missing. A line price may be assumed even without a shared ingredient. UI exposes which source won.
2. A line is computable only if quantity, positive quote denominator, matching/convertible units, and price are available. Negative quantity/price rejected; zero quantity allowed.
3. Unit conversions: same unit; supported fixed conversions for mass (kg/g) and volume (L/ml) only. No conversion between mass and volume, no `個`↔g or `尾`↔g without explicit rate. Unsupported conversion makes the line unresolved, not zero-cost.
4. `line_cost = quantity_in_quote_unit / quote.per_quantity * quote.amount_jpy`. Compute with decimal arithmetic; do not round intermediate line amounts.
5. `subtotal = sum(computable lines)`; `adjusted_subtotal = subtotal + cost_adjustment_jpy` if valid. If any line is missing, expose `partial=true` and `unresolved_line_ids`; **never label the number total recipe cost**.
6. When all lines are complete, `total_cost_jpy` = half-up rounded adjusted amount to integer yen. `cost_rate_pct` = total / positive selling price × 100, rounded half-up to one decimal place. These rounding rules are proposed MVP defaults; preserve raw calculation values for diagnosis.
7. If any input was `assumed`, mark computed total/rate as estimate; a deterministic computation does not make assumptions confirmed.
8. A saved version persists input quotes and calculated output as a snapshot with timestamp; current cost from a shared ingredient is a **separate revaluation**, never a silent rewrite of saved versions.

## 3. AI Mutation Contract

The Meta adapter returns **proposals only**. Proposed envelope:

```json
{
  "recipe_id": "r1",
  "base_revision": 3,
  "operations": [
    {"op": "set_material_quantity", "material_id": "m1", "value": "4", "unit": "尾", "status": "confirmed"}
  ]
}
```

MVP operations: `add_material`, `set_material_quantity`, `set_material_price`, `set_selling_price`, `set_title`, `set_steps`, `link_ingredient`, `unlink_ingredient`, `save_version`. Read/retrieve intent is handled separately, never as mutation.

Apply pipeline: parse as schema → reject unknown operation/fields and invalid Decimal/units → verify recipe and exact line IDs → verify `base_revision` (stale proposals rejected) → check status/origin evidence and price-source rules → prepare all operations on a copy → commit atomically only if **every operation** validates → increment revision → recalculate cost → persist. A failed batch changes nothing.

The model must not mark its inferred values confirmed. `confirmed` is allowed only where attributable to an explicit user instruction or user approval; reject silent promotion. Ambiguous references are returned as clarification candidates, never guessed and applied.

## 4. Acceptance tests to implement in P2

1. `海老3尾` confirmed quantity + assumed price: estimated total, not confirmed.
2. Change 3→4尾 then set 150円/尾: deterministic difference 150円 per additional tail.
3. Recipe-facing material `でんぷん` linked to `片栗粉`: display name stays unchanged.
4. Three recipes share ingredient: current-price revaluation changes their current estimates; saved snapshots remain unchanged.
5. Null ingredient link: estimate and save with independent price quote.
6. Per-line quote overrides shared catalog price and shows source.
7. kg→g works; piece→g without conversion fails safely and returns partial total.
8. Missing price does not contribute false zero; invalid selling price yields no cost rate.
9. Stale revision, wrong material ID, unsupported op, partial batch failure: no state mutation.
10. AI assumption is not silently promoted to confirmed.
11. Separate saved version preserves original and retains provenance.

## 5. Decisions deferred before implementation

- Python package, web and DB libraries, deployment and microphone path
- Catalog price update semantics and explicit override reset UX
- Cross-unit domain conversions when requested by user
- Storage schema migration and concurrent editor synchronization

The feature implementation deadline / hackathon operational timeline is managed in Notion, not this product contract.
