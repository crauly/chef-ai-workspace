# Storage and Optional Image Evidence — Architecture Decision

**Status:** Product direction approved. Generated recipe-dish illustration storage implemented in PR #128; ingredient-photo workflows remain separate and pending.
**Related:** [MVP](MVP.md), [Architecture](ARCHITECTURE.md), [Core Contracts](CORE_CONTRACTS.md)

## Decision

- Use **Supabase Postgres** for durable recipe state, material lines, shared ingredients and immutable versions. Use **Supabase Storage** for optionally uploaded images. Keep only object paths and metadata in relational records, not binary image contents.
- **Voice/natural language alone is sufficient** for ingredient creation, selection and linking; images are never mandatory. A material can link to a shared ingredient without an image; a shared ingredient may have zero or more images in the future, with one optional image in the first UX.
- When the user supplies a photograph (camera or existing photo), **the system must incorporate that image into the ingredient-matching process** together with the voice/text instruction. Never silently ignore an attached photo. If the chosen model/API does not support image reasoning, explicitly surface that limitation and request confirmation or route to a supported image analysis component; do not claim the image was analysed.
- A photograph is evidence, not definitive identification: packaging can be similar, obsolete or partially obscured. Present a proposed match, provenance and uncertainty; ask a short confirmation when text and image conflict or confidence is insufficient.
- Ingredient images are prioritised over finished-dish images. Recipe hero images may reuse the infrastructure later but do not block the primary demo. External Amazon/Rakuten photo scraping, product search and supplier catalog syncing are outside the MVP.
- A product photo belongs to the **actual shared ingredient/product identity**, not to the abstract recipe-facing material name. Keep the display name intact when linking. Shared ingredient IDs, photos and purchase-product references remain optional.
- A user-selected photo is always included as matching evidence **if image matching is invoked**; it is not merely decorative or silently discarded. Never assert 100% match from image alone.

## Minimum persistence boundaries

- Store recipe state, shared ingredients, immutable version snapshots and request-id deduplication in Postgres with atomic transactions and revision checks. Version snapshots keep resolved cost inputs independently of later shared-ingredient price changes.
- Image table/object metadata: `id`, `ingredient_id`, `storage_path`, `mime_type`, `uploaded_at` (optional caption/provenance). Images must not be required by the ingredient record schema.
- Keep Storage bucket private by default; check authenticated access and per-user ownership policies for read/upload/delete operations. Never expose Supabase service-role keys in browsers. Prefer short-lived access URLs and file limits/type validation.
- Upload-to-row consistency must be managed: handle orphaned objects or failed DB commits, and avoid orphaned references if upload fails.
- No secret API keys, signed URLs or internal operations details should be committed.

## Workflow acceptance cases

1. Voice-only: register and reuse a shared ingredient, link to a recipe material and calculate cost with no photo.
2. Voice plus attached photo: matching pipeline demonstrably uses **both** sources and exposes any uncertain identity before saving.
3. Photo is available but not analysed: user is told clearly; no false confirmation of match.
4. Conflicting photo/text: do not silently pick either; ask user to confirm the actual product.
5. Optional image upload/read/delete preserves correct ingredient linkage and access rules.
6. Shared ingredient photo persists across recipe uses; recipe material display name stays unchanged.
7. Failed upload, deleted object, missing media, network error: preserve usable recipe/cost data and show recoverable error.
8. Versioned cost snapshot does not change when a shared ingredient photo or catalog price changes.

## Sequencing and non-goals

Implement working recipe mutation + transactional persistence + versioning before optional camera/gallery upload and image-assisted identification. Demo must have a working voice/text path without images. Actual image understanding requires a confirmed image-capable inference path; Supabase Storage alone only stores the file and does **not** provide recognition.

Provider setup, deployment configuration, MVP cutoff and test/video scheduling are tracked in Notion, not public product docs.


## Generated recipe illustration persistence — 2026-11-04 (PR #128)

- **SSOT:** private Supabase Storage bucket `chef-recipe-dishes`, with one current record per recipe in `public.recipe_dish_images` (recipe ID, owner ID, object path, MIME type). **Not** the browser's IndexedDB. No binary data stored in Postgres.
- **Authorization:** existing operator-gated frontend proxy → demo-token-verified FastAPI `demo_context` → server-derived owner / owned-recipe lookup → service-role Storage. Neither secret nor raw object URLs are exposed to browsers. SQL RLS is enabled and anonymous/authenticated table grants are revoked.
- **Operation:** generating an illustration still requires an explicit user click. Its output is separately saved as optional illustration metadata, never treated as source/evidence for price, ingredients, or recipe content. No recipe revision or Human Gate bypass is introduced.
- **Legacy:** IndexedDB is read only as a fallback on the original device. Legacy images are migrated by an explicit button; the local copy is not removed. Newly generated images upload directly to cloud; if that fails, they remain device-local when browser storage permits, explicitly marked unsynced.
- **Integrity:** 4 MiB max, PNG/JPEG/WebP payload and byte signatures validated; old cloud object replaced using a new immutable key, with best-effort cleanup on replacement or recipe deletion. A failed metadata update cleans up the new upload.
- **State of deployment:** the schema was applied on 2026-11-04 to **only** the dedicated Chef AI Workspace Supabase project. PR #128 application code must still be merged/deployed and browser/backend tests completed before claiming cross-device operation.
- **Non-goal:** optional *ingredient reference photos* and model image understanding are separate concerns; this change only concerns generated finished-dish illustrations.
