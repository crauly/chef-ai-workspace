# Public demo deployment (manual; no automatic deployment)

Target: **Vercel** for `web/` (Next.js), **Render Free** for FastAPI, and **only** the Chef AI Supabase project `dfvryaybdelgjxihdmth`. Never configure the restaurant operations database.

## Render (manual Blueprint creation)
- After review and merge of PR #27, select **New > Blueprint** in Render, connect the GitHub repository and use the root-level `render.yaml` on `main`. Review the proposed Free service before approving creation; no resource is created by committing the file.
- `autoDeployTrigger: off` intentionally disables automatic releases. Set the four private values in the Render creation screen; never add them to `render.yaml` or GitHub.
- If Render Blueprint import is unavailable, create one Python Web Service manually with the same build/start/health settings below.

## Render (manual web service)
- Runtime: Python; root directory: repository root.
- Build: `pip install -r requirements-api.txt`
- Start: `uvicorn chef_ai_workspace.deploy_server:app --host 0.0.0.0 --port $PORT`
- Health check path: `/health` (liveness only; does not assert database or Muse readiness).
- Server-only secrets: `MODEL_API_KEY`, `SUPABASE_URL=https://dfvryaybdelgjxihdmth.supabase.co`, `SUPABASE_SERVICE_ROLE_KEY`, `DEMO_OWNER_ID`, `DEMO_ACCESS_TOKEN`.
- The start module configures Supabase and fails closed for any other project host.
- Do not print secret values in logs. Configure these values only in provider secret settings.

## Vercel (manual Next.js deployment)
- Root directory: `web`; Framework: Next.js; install/build via lockfile (`npm ci`, `npm run build`).
- Server-only settings: `DEMO_PREVIEW_PASSWORD` (>=24 ASCII characters), `DEMO_ACCESS_TOKEN` (same backend-only demo token), `FASTAPI_BASE_URL` (the Render HTTPS origin).
- Public (non-secret) setting: `NEXT_PUBLIC_DEMO_WS_URL` (the Render `wss://` origin for the realtime relay). Unset means realtime stays unavailable and REST is the path; never put keys behind `NEXT_PUBLIC_`.
- **Do not set** any of the above with `NEXT_PUBLIC_`. Do not expose Supabase or Meta keys in Vercel.
- HTTPS and the existing HTTP Basic preview gate remain mandatory.

## Cold start / verification
Render Free may sleep between requests. The initial library GET now performs bounded retries when the Next proxy reports 502/503/504, and displays a waiting status. The backend proxy has a 30s timeout per attempt. This is intentionally **GET-only**: create, confirm, AI-propose and correction POSTs must not replay automatically after an uncertain response.
- Validate `/health` for liveness but do not confuse it with authenticated DB connectivity.
- After manual deployment, access the Vercel preview with HTTP Basic and load the recipe library (this verifies the protected Next-to-FastAPI-to-Supabase read path).
- Then exercise explicit AI proposal, diff, approval, revision persistence and reload, using only dedicated test data and confirmed demo owner.
- Validate fresh cold start, HTTP Basic rejection, error cases, and that no secrets are present in browser responses.
- Never claim external deployment or end-to-end production verification until these checks actually pass.

## Existing Git-linked Vercel project and private ownership

For the existing hosted demo, preserve its project, aliases, environment and
root `vercel.json` service configuration. The manual setup recipes above are
alternatives, not instructions to recreate an already configured project.

Vercel Hobby cannot deploy a private GitHub organization repository. A private
personal repository must satisfy Vercel's Git identity/owner conditions; see
[the official Git deployment rules](https://vercel.com/docs/git#using-hobby-teams).
Keeping source private during development and making it public for submission
are separate owner decisions; never publish source to work around a deploy error.

After an authorized ownership transfer, verify the repository ID, private
visibility, retained PR/history, Git App access and the existing project's Git
connection. Update local `origin` URLs and project-management links. Resume the
normal reviewed-main Git delivery path with an owner-recognized commit, then
verify deployment READY, aliases, commit identity and the existing Basic gate.
Do not substitute a local source upload or change plan/billing to conceal an
unresolved Git permission or entitlement error.
