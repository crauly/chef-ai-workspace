# ADR-014: Dish Image Block 3 — Recipe Illustration Preview (Muse Image)

## Status
Accepted (Block 3, minimal path). Live-verified against `muse-image-1.0` 2026-11-02.

## Context
Block 2 (ADR-013) delivers photo → unsaved proposal (Image Understanding:
real photo analysis). Block 3 is the opposite direction: generate a new
dish illustration with Muse Image and preview it in the app. The two must
not be confused: a generated illustration is never evidence for
quantities, prices, or the finished dish.

## Verified Meta contract (official docs + live probes, no guessing)
- Official `image-generation` doc: single-shot `POST /v1/images/generations`
  is OpenAI Images-API compatible (point base URL at `https://api.meta.ai/v1`,
  Bearer `MODEL_API_KEY`); model `muse-image-1.0`; `n` 1–10 (default 1);
  `size` is aspect-ratio only; `response_format` `b64_json` (default) or `url`;
  `output_format` `webp` (default) / `png` / `jpeg`. The conversational
  Responses-API path exists but is out of scope — single-shot only.
- Live probe 1 (direct API, real key): HTTP 200, `data[0].b64_json` ~329 KB,
  `output_format: webp`, valid RIFF bytes rendering a watercolor tomato-pasta
  bowl (visually confirmed). Cost $0.01/image.
- Live probe 2 (end-to-end `POST /api/dish-image` on a dev server, real key):
  HTTP 200 in ~6 s, `{image: data:image/webp;base64,…}` (~993 KB), valid RIFF.
  Error paths verified through the route: empty prompt → 400 `invalid_prompt`,
  cross-origin → 403 `forbidden`.

## Decision
- New `POST /api/dish-image` (`web/app/api/dish-image/route.ts`): auth via
  existing `previewAuthorized` + same-origin check; validates `{prompt}`
  (1–500 chars); server-side `fetch` to `https://api.meta.ai/v1/images/generations`
  with `{model: "muse-image-1.0", prompt, n: 1}` and a 60 s timeout; returns
  `{image, output_format}` (data URL for `b64_json`, passthrough for `url`).
  Distinct codes: `invalid_prompt` (400), `unavailable` (503, no key),
  `upstream_error` (502), `timeout` (504), `bad_response` (502, wrong shape).
  Stateless: no draft mutation, no persistence, no save path.
- UI (`VoiceRecipeRegistration`, inside the existing draft card only):
  optional hint input (≤200 chars) + 「画像を生成」 button + `<img>` preview
  with a caption stating the image is an illustration, not evidence.
  Prompt = `dishImagePrompt(draft.title, ingredient names ≤8, hint)` (pure,
  exported for tests). Explicit click only — never auto-run on parse/save.
  Own `dishGenerating` / `dishFailed` flags and status rows (spinner while
  the flight runs), independent of voice/photo/price states; draft object
  untouched on completion (no revision/epoch bump), so a late voice/price
  result is never clobbered. Double-submit guard via disabled button +
  in-flight return; `AbortController` aborted on unmount and on draft clear.
- No changes to Structured Output, Tool Calling, Search Grounding, price
  search, Human Gate, or save paths. No new storage (preview data URL /
  temporary URL in memory only, per `IMAGE_STORAGE_DECISION.md` sequencing).

## Tests
- `web/tests/dish-image.spec.ts` (5 cases): prompt helper content + hint cap;
  empty/oversized/missing prompt rejected pre-flight; missing key → 503;
  b64 → data URL with `model: muse-image-1.0, n: 1` asserted on the wire;
  url passthrough; upstream 500 → `upstream_error`, empty data →
  `bad_response`.
- `tsc --noEmit` clean. Focused spec run only (existing suites not re-run).

## Open / verify on device
- Real-device check: draft card → hint → 画像を生成 → spinner row →
  preview image + illustration caption → failed flight keeps draft.
- Double-tap on a slow network (guard holds single flight).
- Generation cost accrues per tap ($0.01); no rate limiting added.
- Persistent saving / public sharing of generated images is out of scope;
  revisit `IMAGE_STORAGE_DECISION.md` before adding any store.

## Follow-up (review #104)
1. Preview reset on save: `save()` now aborts the dish flight and clears
   preview/failure/hint (the panel stays mounted while hidden), so neither a
   completed preview nor a late response crosses into the next recipe.
2. Prompt budget: `dishImagePrompt` guarantees ≤500 chars (shed trailing
   ingredients, then hint, then hard slice), so the UI never offers a request
   the route must reject. Title head + explicit hint survive.
3. Abort silence + stale guard: `generateDishImage` captures the draft object
   at start; completion lands only on that exact object (`dishCompletionKept`),
   and `catch` returns silently on abort (`controller.signal.aborted` /
   `isAbortError`). HTTP/timeout failures still arrive as `Error("<status>")`
   and keep their failure display. `clear()` already aborted + reset; the
   identity guard covers already-settled fetches too.


## 2026-11-04 extension — durable generated image storage (PR #128)

Block 3's original **preview-only** restriction is superseded **only for saved-recipe generated illustrations**. The generation API remains stateless; the user-requested artwork is stored separately through a trusted, owner-scoped backend into private Supabase Storage, not in recipe state or model evidence. Existing device-local illustrations remain as explicit legacy migration candidates. This does not authorize automatic persistence of unsaved voice-draft images or ingredient identification evidence. Implementation and rollout details: [IMAGE_STORAGE_DECISION.md](IMAGE_STORAGE_DECISION.md).
