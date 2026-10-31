# ADR-011: Muse Spark Structured Output (JSON Schema)

## Status
Accepted (Phase C). Chat Completions verified surface; Responses unverified.
Voice-recipe schema live acceptance recorded 2026-10-31 (opt-in).

## Context
Phase C moves Muse Spark 1.3 natural-language understanding to JSON Schema
Structured Output for intent classification and recipe structuring, without
changing the voice harness, draft, approval, or save contracts.

## Decision
- SSOT: `web/muse-schemas.ts` (`INTENT_SCHEMA`, `VOICE_RECIPE_SCHEMA`,
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
  nested `materials` (6 string fields) and `interpretations` verified.
  First probe returned unit `"grams"`: the minimal probe prompt lacked the
  production "Allowed units" constraint, and the app-side value gate
  (missing[], never silent accept) is the designed backstop. With the
  production constraint mirrored, units conform and package-vs-use
  (quantity 100 vs price_quantity 500) is preserved.
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
- Tests: `web/tests/structured-output.spec.ts` (fixture, no key),
  `tests/test_structured_output_contract.py` (contract pin).
