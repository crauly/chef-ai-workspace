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
