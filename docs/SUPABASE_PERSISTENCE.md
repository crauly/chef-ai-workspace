# Supabase Persistence Integration — First Implementation Slice

**Status:** Initial migration applied to isolated Chef AI Workspace Supabase project; runtime integration tests pending.
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

- Direct client INSERT/UPDATE/DELETE of recipes is now closed at the RLS policy level. A trusted recipe-creation API/RPC is required before this schema supports creating recipes.
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

## Verification status

- GitHub Actions runs the Python unit suite and a **static SQL guardrail test** for RLS presence, restricted mutation RPC grants, expected snapshot and ID-dedup clauses. These are text assertions, **not SQL syntax checks, actual database execution or multi-account security verification**.
- **Completed:** migration applied successfully, tables and RLS policies enumerated, Supabase security advisor returned zero findings.\n- **Not performed:** full Supabase Auth user A/B isolation, Storage bucket policy testing, transactional rollback/parallel request integration tests.
- Dedicated project `chef-ai-workspace` (Tokyo, project ref `dfvryaybdelgjxihdmth`) was created separately from restaurant app `iwaka_project`. Initial migration `chef_ai_workspace_initial_schema` applied successfully on 2026-10-27. Five tables verified with RLS enabled; seven access policies inspected. Supabase security advisors returned no lints. No actual authenticated-user RLS test has yet been run.
