# Recipe library frontend

Next.js UI prototype with recipe cards, create recipe, detail, and rename-and-save.

Run `cd web && npm install && npm run dev`. Configure **server-only**
`FASTAPI_BASE_URL` and `DEMO_ACCESS_TOKEN`. Never use `NEXT_PUBLIC_`
for the demo token. All browser requests use the same-origin
`/api/recipes` route handlers, which proxy to guarded FastAPI demo routes.

**Deployment safety: this prototype's Next.js API proxy is not a public
authorization boundary.** Without restricted deployment access, arbitrary
internet clients could call the server proxy and thereby exercise the
privileged demo workspace. Do not publish it openly until a suitable
restricted-preview access mechanism or read-only public showcase has been
implemented and tested. This deployment restriction is distinct from
production user accounts.

The current UI only exposes title changes; material editing, pricing,
AI proposals, voice and photo flows are not connected yet.
