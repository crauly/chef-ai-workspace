# Supabase Persistence Integration — First Implementation Slice

**Status:** SQL migration drafted; not deployed or integration-tested.
**Depends on:** [Storage decision](IMAGE_STORAGE_DECISION.md), [Core contracts](CORE_CONTRACTS.md).

## Data ownership — confirmed

**Individual ownership**: every Supabase Auth user owns only their own recipes, shared-ingredient catalogue, saved versions and images. No restaurant/team sharing in MVP. RLS isolates users.

## Database schema

- `recipes`: current state JSONB, owner and monotonically increasing revision.
- `recipe_versions`: separate immutable snapshots, including the effective resolved cost snapshot. No update/delete client policy.
- `mutation_receipts`: request-ID deduplication and payload-hash defense.
- `ingredients`: optional shared-ingredient catalog for the account, no required photo.
- `ingredient_images`: optional object paths. Does **not** include the actual image bytes.

The **service-role-only** SQL `commit_recipe_revision` RPC uses a row lock and compare-and-swap revision to update state, insert an optional version, and record replay receipt atomically. A trusted backend must authenticate the end user, derive `p_owner_id` from the verified identity, validate operations, provenance, quote sources and cost **before** calling with service-role credentials. Never allow a browser to provide authoritative owner IDs or access the service-role key. The RPC is not callable as `authenticated` or `anon`. Direct client updates/deletes to `recipes` are barred.

## Important known blockers before production

- Initial client INSERT is provisionally allowed only for own rows; validate creation server-side or narrow this permission before production. It is NOT a substitute for validated recipe creation.
- `security definer` RPC trusts a **service-role-only trusted backend** to authenticate caller and verify proposed JSON/cost. Never pass a user-supplied owner identifier without verifying identity.
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
