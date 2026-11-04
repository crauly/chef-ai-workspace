# Headless API runtime (initial slice)

This page describes the initial production-auth slice. For the current protected
single-workspace UI and real Meta inference path, see
[the UI workflow](../web/README_WORKFLOW.md) and [Meta Responses](META_RESPONSES.md).
The historical incomplete items below are not a current implementation inventory.

`chef_ai_workspace.api:app` provides `GET /health` and `POST /recipes/{recipe_id}/confirm`.
The endpoint is an **explicit authenticated confirmation action**: the user
reviews the proposal in the frontend and presses Confirm. AI-generated proposals
must never call it autonomously. The server obtains the owner ID from a **verified**
Supabase access token via `auth.get_user`, not from request JSON, and uses a
service-role Supabase client **only on the server**.

Server setup:
```python
from chef_ai_workspace.server_config import configure_supabase
app = configure_supabase()
```
Run with `uvicorn your_module:app` after setting `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` in private backend environment settings. Never
expose the service-role key as `NEXT_PUBLIC_*`.

**Incomplete / not deploy-ready:** CORS allowlist, authenticated recipe
creation/listing endpoints, comprehensive proposal preview and user approval
evidence, validated real UUID recipe IDs and test fixtures with live Supabase,
app-based mobile/voice/photo E2E. No Meta model inference path is connected yet.

## PR #127: read-only recipe price research

`POST /api/recipe-price-research` requires the preview operator gate and same-origin POST.
Input: `{recipe_id: UUID, base_revision: integer, instruction: string (1..4000)}`.
The server loads the owner-scoped saved recipe and unit master through the trusted
backend; submitted material names, supplier flags, or owner IDs are not authoritative.
Missing/inaccessible recipes fail before inference; stale revisions return 409.

The scope response contains selected zero-based `indices` (all, named subsets,
inclusive ranges, or an ambiguous empty set) and an `edit_instruction` containing
only requested non-price edits. Every selected row receives a result; three is a
concurrency limit, not a total-row limit. Existing contracts limit recipes and
confirmation batches to 40 materials/operations. Combined requests exceeding 40
operations must be split explicitly and are never truncated.

Results include candidate operations, per-row status, ledger/Web outcome, observation
IDs/times, and available source URLs, seller/package quotes and tax/shipping terms.
Linked Ingredient IDs select only their own ledger evidence; repeated ingredient
IDs share one researched quote. Usable JPY ledger evidence wins before actual grounded Web
search; history with incompatible currency, numeric values or units triggers Web
fallback and remains separately identified in the research status. Supplier/offer-linked rows require the existing offer-price adoption path
and produce no direct master-price operation; their research evidence is still
returned for comparison instead of silently excluding the selected row. Unknown units, unapproved conversion
ratios, unsupported currencies and failed retrievals remain unresolved without zero
substitution. Web package normalization is checked against approved owner factors.

The UI combines grounded prices with the existing proposal API's quantity, selling
price and title edits. Model-generated purchase prices are excluded. Other combined
operations require a separate instruction. All results, including all-failed
research, remain inspectable before approval. Price changes update the shared
Ingredient master, not an independent per-recipe price. The existing confirm route
retains explicit Human Gate, owner authorization, base revision/CAS, atomic writes,
and stable request IDs for uncertain-save retries. This endpoint performs no writes.

Errors: 400 invalid request, 403 operator/origin denied, 404 inaccessible recipe,
409 stale recipe, 502 invalid/upstream response, 503 missing configuration/unit catalog.
Lightweight mocked regression: `cd web && npm run test:price-research` (Node only;
no Playwright, browser, live DB, or real model/search call).

For saved ingredients, `GET /demo/price-reference?ingredient_id=<UUID>` is an
additive exact-identity lookup. The backend loads that ingredient for the configured
owner (404 for an inaccessible ID) and bypasses the three name-search suggestions;
`name`-only callers keep their existing behavior. Observation evidence also carries
available tax/shipping notes. Both the backend and frontend changes must be released
for this exact-ID lookup. Focused backend regression: `python -m unittest discover
-s tests -p 'test_price_reference.py' -v`.

## Approved recipe procurement

`POST /demo/recipes/full` (Web proxy: `/api/recipes/full`) accepts optional
`materials[].supplier` and saves approved supplier identity, Offer selection and
complete purchase quotes atomically with the recipe. Incomplete draft price tuples
remain null. Supplier names and effective adopted prices are returned on detail
reads; line costs use the same selected Offer. The owner-local abstract supplier
`相場参考価格` has a real ID. Named suppliers never fall back to its price.
See [the save contract and migration runbook](APPROVED_RECIPE_PROCUREMENT.md)
and [ADR-009](ADR_009_INGREDIENT_PROCUREMENT_ASSISTANCE.md) for retry conflicts,
legacy NULL compatibility, approval and deployment boundaries.
