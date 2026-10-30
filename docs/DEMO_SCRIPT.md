# Demo script (operator runbook + 3-minute video scenario)

Environment: local or preview deployment with the isolated demo owner.
All prices below are fixture/demo values, never market data.

## One continuous flow (operator steps)

1. **Voice registration.** Open the workspace, dictate a new recipe
   (e.g. peperoncino: pasta 100g, olive oil, garlic). The proposal shows
   a diff with assumed/unresolved marks; the chef corrects and approves
   explicitly (Human Gate). Save → reload shows the same state.
2. **Ingredient reuse.** In a second recipe say "same pasta as the
   peperoncino": the same owned ingredient ID is linked, with its price
   source shown.
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
- 1:10-1:50 Reuse ("same pasta"), cost view with a partial line.
- 1:50-2:30 Price confirmation → bell → impacted recipes and cost delta.
- 2:30-2:55 Sourcing suggestions: three kinds, sources, gaps, no auto-apply.
- 2:55-3:00 Limits card: fixture-verified; live-DB/inference/retrieval
  unverified; no auto purchasing or monitoring.

## Do-not-claim list (narration guardrails)

- Never present fixture prices as market data or recognition accuracy.
- Never imply notifications adopt prices or switch suppliers.
- Never show the unavailable external retrieval as working.
