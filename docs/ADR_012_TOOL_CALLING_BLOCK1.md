# ADR-012: Tool Calling Block 1 — Read-Only Owned-Ledger Lookup

## Status
Accepted (Block 1, opt-in). Live-verified against `muse-spark-1.3` 2026-11-02.

## Context
The voice-recipe `price_research` → ledger → `web_search` loop already resolves
prices, but `link_ingredient` can only reference caller-prefilled
`ingredient_candidates` (capped, substring-only). There was no on-demand way for
the model to resolve an owned ingredient ID. Block 1 adds exactly one read-only
tool for that gap. No existing orchestration is duplicated or replaced.

## Verified Meta contract (live probes, no guessing)
- Responses API: flat tools `[{type: function, name, description, parameters}]`
  → `function_call{name, arguments (JSON string), call_id, status}` items.
  Manual `function_call` + `function_call_output` replay with `store: false`
  works. `previous_response_id` chaining fails with `store: false`
  ("not found or expired") — so Block 1 replays manual stateless history.
- Chat Completions: nested `tools: [{type: function, function: {...}}]` →
  `tool_calls[]` with `finish: tool_calls`. Verified on the same model.
- `tool_choice: "required"` → HTTP 400 (only `auto` supported).
  `parallel_tool_calls` defaults to true; Block 1 caps at 4 calls/turn app-side.

## Decision
- New tool `search_owned_ingredients{query, limit?}` (`chef_ai_workspace/tool_ledger.py`).
  The executor takes an owner-scoped `search(query, limit)` callable (the
  repository's `search_owned_ingredients`, same method `_owned_candidates`
  uses) — never the recipe-costing catalog, which only holds already-linked
  IDs and is empty for unlinked recipes. Only well-formed id/name rows from
  that search reach the model. Read-only: no create/modify/delete/persist.
  Unknown tool names raise `ToolLedgerError` (fail closed); invalid arguments
  return `{"error": ...}` to the model (recoverable); search failures return
  `{"error": "search_failed"}`.
- New `MetaResponsesProvider.propose_with_tools(instruction, ctx, catalog,
  max_tool_turns=0..2)` (`meta_responses.py`). Manual-history loop; final turn
  parsed by the untouched strict `parse_response` (which still rejects tool
  items). Unknown tool / transport / timeout / refusal / incomplete /
  loop-exhaustion → `ProposalProviderError` → existing HTTP 502. `propose()` and
  `classify_intent()` are byte-identical paths, untouched.
- New opt-in endpoint flag `POST /demo/.../propose?tools=ledger` (`demo_api.py`).
  Default `""` keeps the legacy path; other values → 422; non-Meta provider →
  503. The tool search is built by `_tool_search` (owner-scoped repository
  search; substring fallback over the recipe catalog only when the repository
  lacks that method). Tool-resolved link IDs are merged into the validation
  catalog via owner-scoped `load_owned_ingredients` — the same explicit-ID
  pattern as `save_recipe_with_ledger` — so `prepare_mutation` ownership
  checks pass without weakening them. Downstream mutation validation and the
  Human Gate are unchanged.
- Every turn's assistant messages are strictly validated (`_tool_calls`):
  role/status/content-shape, so refusals and incomplete messages fail closed
  on intermediate tool turns as well as final ones.
- Muse decides *when* to look up; the app executes, validates, and still
  requires explicit chef approval before anything persists. AI never saves.
- Provenance check (follow-up): a final `link_ingredient` whose string
  `ingredient_id` was not returned by a tool call in the same session is
  rejected with `ProposalProviderError` (fail closed, app-side, not prompt).
  Non-string/missing IDs stay with the downstream validator (422); ownership
  and approval stay downstream. `propose()` has no such check.

## Search Grounding relationship: kept independent, not replaced
Grounding (`web_search` + evidence-anchored ledger flow) is a server-side
retrieval backend with source/price guarantees. Tool Calling is model-driven
ID discovery. Replacing Grounding with a tool would mean building a new search
backend with no evidence contract — out of scope. The two stay independent;
their only shared surface is the owned catalog they both read.

## Caps
max_tool_turns ≤ 2, ≤ 4 calls/turn, 25s/turn timeout, strict final parse,
existing 40-operation limit. No unbounded retry.

## Verification
- `tests/test_tool_ledger.py` (34 tests, offline, incl. `IntermediateMessageTests`
  and `ToolEndpointWiringTests` for both review findings): executor units, happy-path
  loop, invalid-args recovery, unknown-tool/timeout/HTTP/refusal/loop-exhaustion
  fail-closed, no-call passthrough, per-turn cap, legacy `propose()` sends no
  `tools`, endpoint `tools=bogus` → 422, plus `LinkProvenanceTests` (7 tests):
  tool-returned ID accepted, forged ID / link-without-tool-call fail closed,
  error results contribute no IDs, non-link ops and malformed link shapes pass
  through to the existing downstream validator, legacy `propose()` unchecked.
- `tests/test_tool_ledger_live.py` (opt-in `CHEF_LIVE_META=1`): random-UUID
  catalog proves the model used the tool-returned ID in `link_ingredient`.
  Passed 2026-11-02 (bounded retry x3: live sampling occasionally abstains
  without calling the tool; the assertion itself is unchanged).
- Full suite 417 tests OK; `npx tsc --noEmit` clean; `npm run build` clean.

## Remaining
- Block 2+ candidates (e.g. price-history lookup tool) need their own contract
  probes; `tool_choice` required-mode is unsupported by the API — do not rely on
  forced calls. Multi-turn `previous_response_id` chaining needs `store: true`
  semantics review before use.
