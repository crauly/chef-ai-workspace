# Master Management Contract (SSOT)

This document is the single contract for the ingredient and unit management UI, HTTP routes and database persistence. Do not create a second CRUD workflow or an AI-only bypass.

## Ownership and execution boundaries

- **Upstream — Next.js settings UI**: `IngredientManager` and `UnitManager` display owner-scoped lists and explicit create/edit/delete actions. Confirm destructive operations. Browser validation is usability only, not authorization.
- **Middle — Next.js routes and FastAPI**: `/api/ingredients`, `/api/ingredients/[id]`, `/api/units`, `/api/units/[id]` use preview authorization and same-origin checks for writes. They forward to corresponding `/demo/*` endpoints, where `demo_context` validates the server-side access token and resolves the configured owner. The client cannot supply an owner ID. These demo routes are **not** a general multi-user authentication mechanism.
- **Downstream — Supabase repository and PostgreSQL**: only service-role-accessible owner-scoped RPCs may write master records. RLS and table write revocations prevent direct browser writes. SQL handles duplicate identities, ownership, transactions and deletion reference guards. Never ship the service-role key to the browser.

## Single source of truth

- `ingredients`: canonical ingredient identity and current purchase price.
- `units`: canonical unit identity, dimension, aliases and optional explicit conversion.
- Recipe materials reference canonical owner-owned ingredient and unit IDs. Current recipe valuation inherits the ingredient master; immutable recipe-version snapshots remain historical records.
- The recipe-save Human Gate registers AI-proposed ingredients/units **only** inside the authorized atomic save transaction. Separately, the settings CRUD route permits **explicit human-initiated** master creation. This is not an AI approval bypass; the server must not invoke manager CRUD from an AI proposal or automatic background workflow.
- No inferred unit conversion or automatic fuzzy merge. Ambiguous identity must be resolved by a person.

## CRUD contract

| Action | Ingredient | Unit |
| --- | --- | --- |
| Read | owner-scoped GET | owner-scoped GET |
| Create | explicit manager POST | explicit manager POST with dimension |
| Update | PUT name and optional full price quote | PUT symbol, dimension, factor and aliases |
| Delete | explicit DELETE; reject dependent references | explicit DELETE; reject dependent references |

Deleting records that are referenced by current recipes, historical recipe versions, procurement or images must fail. SQL is the final enforcement layer. The UI must show an error rather than pretending success.

## Review and release gate

1. Verify the settings components, Next.js routes, FastAPI repository calls and SQL migration names match end to end.
2. Run Python and Next.js CI on the PR HEAD.
3. Exercise isolated transactional DB create/delete and referenced-delete rejection without leaving test data.
4. Verify browser-facing API authorization and same-origin protection. Confirm no alternate direct table-write route.
5. Merge only after tests pass; deployment and actual browser smoke tests are separate release checks.

This contract is intentionally limited to the current Chef AI Workspace demo-owner architecture. Replacing demo authorization with general multi-user auth requires a separate approved design, not implicit expansion of this feature.
