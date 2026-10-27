# Supabase Persistence Integration — First Implementation Slice

**Status:** SQL migration drafted; not deployed or integration-tested.
**Depends on:** [Storage decision](IMAGE_STORAGE_DECISION.md), [Core contracts](CORE_CONTRACTS.md).

## Data ownership assumption requiring confirmation

This migration assumes **Supabase Auth user identities**, with each user's recipes, ingredients and images private to that user by default. A shared restaurant/workspace account model would require a different ownership/RLS policy. Do not deploy until this product decision is confirmed.

## Database schema

- `recipes`: current state JSONB, owner and monotonically increasing revision.
- `recipe_versions`: separate immutable snapshots, including the effective resolved cost snapshot. No update/delete client policy.
- `mutation_receipts`: request-ID deduplication and payload-hash defense.
- `ingredients`: optional shared-ingredient catalog for the account, no required photo.
- `ingredient_images`: optional object paths. Does **not** include the actual image bytes.

The SQL `commit_recipe_revision` RPC uses a row lock and compare-and-swap revision to update state, insert an optional version, and record replay receipt atomically. Application still must validate operations, provenance, quote sources, and cost **before** calling. A server-side trust boundary is needed before treating submitted JSON as authoritative; direct client writes to `recipes` should be removed/limited before a production deployment.

## Important known blockers before production

- Current broad `recipes_owner` policy permits authenticated owner updates directly, bypassing the RPC. **Must tighten to select/insert only** and use a restricted server/RPC write path after initial creation.
- The RPC is security-definer, and any client with owner access can submit arbitrary `p_new_state`/cost JSON. Validate those server-side or have trusted backend issue the calls.
- Cross-owner `ingredient_images` rows and object paths must stay consistent; SQL metadata RLS alone does not configure a Storage bucket or Storage RLS.
- Image bucket creation/upload rules, MIME/size limits, signed reads and orphan cleanup need separate implementation.
- Initial recipe creation and safe version selection remain a separate feature; this PR is schema groundwork, not feature completion.

## Acceptance checks (pending a connected Supabase project)

1. Anonymous requests cannot read rows or invoke commit.
2. User A cannot read or change User B recipe, image metadata or receipt.
3. Correct revision increments once; same request ID+hash returns the same revision.
4. Same request ID with different payload raises; stale revision raises.
5. Rollback on snapshot insert failure leaves current recipe/revision unchanged.
6. Version price snapshot stays unchanged when ingredient price changes.
7. No-image recipes and ingredients remain valid.
