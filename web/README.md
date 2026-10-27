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

## Ingredient presentation contract

In a recipe, display the chef-facing per-line `material_name.value` as the **food/ingredient name** (食材名), not an internal ingredient-master category, purchasing item, or linked catalog `name`. For example, a chef's `片栗粉` should not be silently rewritten to `澱粉`. Preserve `ingredient_id` separately for shared pricing and later procurement details. Never infer or replace a missing chef-facing name with the catalog label; show `食材名未設定` until the chef supplies one. A linked product's supplier, last purchase and price history can be added later through a separate detail interaction without changing recipe wording.
