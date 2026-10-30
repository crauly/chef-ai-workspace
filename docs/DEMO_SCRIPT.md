# Demo script (operator runbook + 3-minute video scenario)

Environment: local or preview deployment with the isolated demo owner.
All prices below are fixture/demo values, never market data.

## One continuous flow (operator steps)

1. **Voice registration.** Open the workspace, dictate a new recipe
   (e.g. peperoncino: pasta 100g, olive oil, garlic). The proposal shows
   a diff with assumed/unresolved marks; the chef corrects and approves
   explicitly (Human Gate). Save → reload shows the same state.
2. **Ingredient reuse (explicit assist + confirm, demo API).**
   Voice auto-reuse from speech alone is unavailable in the current Web UI:
   saving from voice (`POST /demo/recipes/full`) creates unlinked material
   lines. Demonstrate reuse with the wired flow instead:
   (a) save the second recipe (voice/UI) so it has an unlinked "pasta" line;
   (b) `GET /demo/ingredients/search?q=pasta` shows the owned candidate
   carrying the first recipe's ingredient ID;
   (c) `POST /demo/recipes/{second_id}/ingredient-assist`
   `{material_id, name}` returns `reuse` with that candidate
   (`new` returns a `suggested_new_id`);
   (d) `POST /demo/recipes/{second_id}/confirm` with
   `ledger: [{kind: "reuse", id}]` (or `kind: "new"` with the suggested ID)
   links it in the same approved request (Human Gate).
   Reload shows the linked real ingredient name with the material name kept.
3. **Cost view.** Open recipe detail: current food cost and cost rate.
   Unpriced lines stay partial -- never zero-filled.
4. **Price check → bell.** Confirm a new price observation for pasta
   (e.g. 500g/¥420 vs adopted ¥350). The bell lists the change with
   unit basis (¥/g), affected recipes and current-cost impact.
   Acknowledging never adopts a price.
5. **Sourcing suggestions.** Enter the pasta ingredient ID: same-supplier
   terms, other suppliers and unknown-supplier terms appear separately,
   each with terms, source, observed time and gaps. External retrieval is
   shown as unavailable -- nothing is invented.

## 3-minute video scenario

- 0:00-0:20 Problem: costing labor for a small restaurant; what this app does.
- 0:20-1:10 Voice registration with a mid-course correction, explicit
  approval, save and reload.
- 1:10-1:50 Reuse via search → ingredient-assist → ledger confirm
  (same owned ID), cost view with a partial line. Do not narrate this as
  voice auto-linking.
- 1:50-2:30 Price confirmation → bell → impacted recipes and cost delta.
- 2:30-2:55 Sourcing suggestions: three kinds, sources, gaps, no auto-apply.
- 2:55-3:00 Limits card: fixture-verified; live-DB/inference/retrieval
  unverified; no auto purchasing or monitoring.

## Do-not-claim list (narration guardrails)

- Never present fixture prices as market data or recognition accuracy.
- Never imply notifications adopt prices or switch suppliers.
- Never show the unavailable external retrieval as working.
- Never present voice auto-reuse of an existing ingredient ID as working.
  The voice UI save path (`/api/voice-recipe` → `/demo/recipes/full`)
  carries no ingredient IDs or past-recipe context; reuse needs the
  explicit search → ingredient-assist → ledger-confirm steps above.
