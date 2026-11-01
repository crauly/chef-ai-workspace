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
  Executor runs `ingredient_assist.search_owned_ingredients` against the supplied
  owned catalog; every returned ID is validated against that catalog. Read-only:
  no create/modify/delete/persist. Unknown tool names raise `ToolLedgerError`
  (fail closed); invalid arguments return `{"error": ...}` to the model (recoverable).
- New `MetaResponsesProvider.propose_with_tools(instruction, ctx, catalog,
  max_tool_turns=0..2)` (`meta_responses.py`). Manual-history loop; final turn
  parsed by the untouched strict `parse_response` (which still rejects tool
  items). Unknown tool / transport / timeout / refusal / incomplete /
  loop-exhaustion → `ProposalProviderError` → existing HTTP 502. `propose()` and
  `classify_intent()` are byte-identical paths, untouched.
- New opt-in endpoint flag `POST /demo/.../propose?tools=ledger` (`demo_api.py`).
  Default `""` keeps the legacy path; other values → 422; non-Meta provider →
  503. Downstream mutation validation and the Human Gate are unchanged.
- Muse decides *when* to look up; the app executes, validates, and still
  requires explicit chef approval before anything persists. AI never saves.

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
- `tests/test_tool_ledger.py` (18 tests, offline): executor units, happy-path
  loop, invalid-args recovery, unknown-tool/timeout/HTTP/refusal/loop-exhaustion
  fail-closed, no-call passthrough, per-turn cap, legacy `propose()` sends no
  `tools`, endpoint `tools=bogus` → 422.
- `tests/test_tool_ledger_live.py` (opt-in `CHEF_LIVE_META=1`): random-UUID
  catalog proves the model used the tool-returned ID in `link_ingredient`.
  Passed 2026-11-02.
- Full suite 410 tests OK; `npx tsc --noEmit` clean; `npm run build` clean.

## Remaining
- Block 2+ candidates (e.g. price-history lookup tool) need their own contract
  probes; `tool_choice` required-mode is unsupported by the API — do not rely on
  forced calls. Multi-turn `previous_response_id` chaining needs `store: true`
  semantics review before use.
