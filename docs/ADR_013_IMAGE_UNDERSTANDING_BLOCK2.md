# ADR-013: Image Understanding Block 2 — Photo → Unsaved Recipe Proposal

## Status
Accepted (Block 2, minimal path). Live-verified against `muse-spark-1.3` 2026-11-02.

## Context
Voice-recipe parsing (`POST /api/voice-recipe`, Chat Completions +
`VOICE_RECIPE_SCHEMA` strict `parse()`, Human Gate) is the only draft
validation path. The Python backend has no image handling; no upload UI
exists. `docs/IMAGE_STORAGE_DECISION.md` requires: a supplied photo must
feed matching, never be silently ignored; photo is evidence, never sole
identification; quantities/prices never from image alone; no false
confirmation without an image-capable path.

## Verified Meta contract (official docs + live probes, no guessing)
- Official `image-understanding` doc: Chat Completions takes
  `{image_url:{url:<public URL|base64 data URL>}}` in a user message;
  Responses API takes a plain-string `input_image`; images only in
  user-role messages; model `muse-spark-1.3` is image-capable.
- Official limits: inline image <= 50 MB, <= 50 images/request (>50 →
  HTTP 400), MIME `jpeg/jpg/png/gif/webp/x-icon`; undecodable bytes →
  HTTP 400. ~1,300–1,500 tokens per ~1280px image.
- Live probe 1 (Chat Completions + data-URL PNG): HTTP 200, model saw the
  image ("too blurry" for a 1x1 pixel — correct).
- Live probe 2 (image + `response_format json_schema strict`): HTTP 200
  `finish: stop`, unknown values returned empty/unresolved, nothing
  invented. Structured Output and vision compose on this model.
- Live probe 3 (end-to-end `POST /api/image-recipe`, real key, 1x1 PNG +
  text "トマトパスタ"): HTTP 200 deferred draft; materials have empty
  quantity/price/unit; `missing[]` blocks approval; uncertainty in
  `notes[]`; user label recorded in `interpretations[]`.

## Decision
- New `POST /api/image-recipe` (`web/app/api/image-recipe/route.ts`,
  Next.js, not Python): input `{image: <data URL>, text?: string}`.
  MIME allow-list mirrors the official six; other types → 400
  `unsupported_media`, malformed → 400 `invalid_image` (both before any
  upstream call). Body ceiling mirrors the official 50 MB inline cap
  (base64-inflated); upstream 400 → 422 `undecodable_image` (retake, not
  retry); other upstream/model failures → 502 with distinct codes, never
  a draft. The route is stateless, so failures cannot overwrite a draft.
- Upstream reuses `VOICE_RECIPE_SCHEMA` via `chatResponseFormat`
  (`chef_image_recipe`); developer prompt orders: quantities, weights,
  prices, selling price stay empty unless the user text states them; a
  visible label is a name hint only; photo/text conflicts go to `notes`;
  proposal only, no saving, no tools.
- Shared `web/recipe-draft-parse.ts`: `parse()` moved verbatim from
  `voice-recipe/route.ts` (same Human Gate bar for both routes; that
  route now imports it, behavior unchanged).
- Response is the deferred voice-draft shape (`research_state:
  "deferred"`, `provisional_prices: null`, `pending_research` via
  `assembleEntries`): the existing draft card, approval gate, and
  `POST /api/voice-recipe/prices` lifecycle attach unchanged. No
  `enrichEntries` here, so no image-guessed price reaches the save path.
- No Tool Calling in this route (Block 1 untouched); Search Grounding
  not replaced — `price_research` (normally `[]` for photos) would flow
  through the existing ledger → grounding loop after the chef confirms
  quantities. Voice transcription and grounding behavior unchanged.

## Tests
- `web/tests/image-recipe.spec.ts` (5 tests): draft contract + image in
  upstream payload; `unsupported_media` / `invalid_image` pre-upstream;
  422 vs 502 distinction; no draft on failure.
- Regression: `voice-recipe-deferred` (9), `structured-output` (8),
  `voice-price-lifecycle` + `voice-conversation` (17/18) pass.
- Known pre-existing failure (not this change): 
  `voice-conversation.spec.ts:80` "queued fragments coalesce …" fails
  identically on clean `main@40f7a80` (verified via `git stash -u`).

## Open / verify on device
- Large phone photos (multi-MB data URLs) against the body ceiling and
  Next.js default body handling; add an app-side downscale only with
  measured evidence.
- Photo + voice combined matching (both sources in one decision) is
  future work; this block delivers photo → proposal and voice → revision
  on the same draft contract.
- Grounding coordinates (0–1000 boxes/points, overlay HTML) verified in
  docs only; not implemented (out of scope).
