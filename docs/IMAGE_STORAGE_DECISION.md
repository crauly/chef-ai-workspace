# Storage and Optional Image Evidence — Architecture Decision

**Status:** Product direction approved; implementation pending.
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
