# Protected chef approval workflow

This single-workspace MVP has no product user accounts or login screen.
The preview uses an operator HTTP Basic access gate (`chef` plus a shared
password). The browser's native access prompt protects both the page and API;
it is separate from future Supabase Auth accounts. Use HTTPS in deployments.

## Server-only configuration

- `DEMO_PREVIEW_PASSWORD`: independent, random ASCII secret of at least 24 characters.
  With no strong password configured, requests are denied (including locally).
- `FASTAPI_BASE_URL`: trusted backend HTTPS origin; HTTP is allowed only for loopback development.
- `DEMO_ACCESS_TOKEN`: backend-only demo token, distinct from the preview password.

Never prefix these with `NEXT_PUBLIC_`. No Supabase or AI credentials belong
in the web environment. The backend owns all database/model access and the
fixed demo owner. Keep that backend's demo endpoints token-protected.
Use only dedicated Supabase project `dfvryaybdelgjxihdmth`.
Restaurant operations project `jfaxjgvqfsacprenodkg` is strictly out of scope.
This UI change requires no schema migration.

The proxy independently checks preview authorization and same-origin POSTs,
allows only fixed recipe endpoints, rejects invalid UUID paths, avoids caching
and redirects, and does not expose upstream error bodies or headers.
Deployment-provider restricted access may be added outside this gate.

## Interaction

1. Open a recipe and type an instruction (Japanese or English).
2. Request a proposal. FastAPI validates it on a copy without persisting.
3. Read the original instruction and each before/after change. Empty or stale
   proposals cannot be approved. Editing the instruction discards the proposal.
4. Check approval of every proposed value, then press the explicit approval
   button. Only that action calls `/confirm`, with the proposal's base revision,
   one stable request UUID and `save_version=true`. Network retries reuse the UUID.
5. FastAPI validates, recalculates deterministically and atomically persists the
   revision/snapshot. The UI reloads current cost. Conflicts reload the selected
   recipe automatically and require a fresh proposal and approval.
6. Optional: explicitly register original/preferred phrases in correction history.
   This does not mutate the recipe or automatically accept subsequent suggestions.

The backend supports a dedicated Meta Responses adapter through server-only
`MODEL_API_KEY`; see [Meta integration](../docs/META_RESPONSES.md). Model attribution
is displayed with each proposal. Substitute adapters and browser fixtures are
not evidence of Muse behavior; no automatic fallback is introduced. Codex CLI's
401 is a separate authentication path. Voice/photo and real-device/live-database
E2E remain separate work.

## Verification

`npm ci`, `npm run build`, `npm run typecheck`, `npx playwright install chromium`,
`npm test`. CI runs the build, typecheck and browser scenarios. Browser tests
use an isolated local fixture backend with no database or real model. Python
tests additionally exercise real FastAPI validation, deterministic mutation/cost,
explicit confirmation, replay, conflicts and correction registration using an
in-memory repository. These do not prove live Supabase or real inference.
