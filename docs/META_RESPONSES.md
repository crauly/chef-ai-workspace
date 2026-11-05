# Meta Muse Responses integration

The dedicated `MetaResponsesProvider` calls only
`POST https://api.meta.ai/v1/responses` with `muse-spark-1.3`.
It uses native `instructions` and `input`, reads completed assistant
`output[].content[]` blocks of type `output_text`, and strictly parses the
result as an operations proposal. Reasoning is ignored; refusals, incomplete
responses, tool calls, invalid JSON and malformed envelopes fail closed.
The normal Next edit proxy now selects `propose_with_tools` (`?tools=ledger`).
It exposes owned recipe search/detail, ingredient search and price-reference reads,
reusing existing handlers. Manual stateless history (`store=false`) is capped at
2 tool rounds and 4 calls/round, with the remaining 25-second budget passed to
subsequent model transports. The final turn uses the same strict parser.
Registration/navigation use the corresponding bounded Chat Completions loop
with Structured Output; both adapters follow the official tool-result protocol.
See ADR-012 for the normal entrypoints and approval boundary.
The normal mutation validator still checks every operation before preview,
and only the chef's explicit confirm action can persist and recalculate.

Official references:
- [Create response](https://dev.meta.ai/docs/api-reference/responses/create-response)
- [Responses protocol](https://dev.meta.ai/docs/protocols/responses)

`MODEL_API_KEY` is a backend-only environment secret. Keep it in the existing
private Chef server environment; do not copy it to the frontend, commit it,
print it or use `NEXT_PUBLIC_`. No new SDK or secret storage is required.
`configure_ai` prefers this adapter when that key is present, independently
of the explicit legacy `AI_API_KEY` Chat Completions configuration. A Meta
failure never silently falls back to another provider. No endpoint override
can redirect the Meta key. Redirects are refused; errors omit upstream bodies.
The key is omitted from the adapter's representation.

Each request sends the current structured recipe and relevant correction
candidates, preserving the original chef instruction. `store=false` avoids
server-managed response history; this slice does not chain response IDs or
persist reasoning. Sampling remains at the Meta defaults. Low reasoning and
a 4096-token output budget bound this focused editing task. JSON is requested
through instructions and validated locally, without claiming schema-enforced
generation. No Chat Completions `messages`/`response_format` is sent to Responses.

The proposal response contains public provider/model attribution only, which
the UI displays with the diff. No API key or authentication headers are returned.
The existing server proxy, protected single workspace, locale support, revision
conflicts and stable confirmation request IDs remain in place.

## Verification

Normal `python -m unittest discover -s tests` mocks Meta transport and tests
native request/response shape, no persistence before approval, failure cases,
and explicit adapter selection. Existing browser tests cover the diff and
approval flow with an isolated fixture, including model attribution.

Real-inference test (explicit opt-in; never runs in CI by default): set
`MODEL_API_KEY` through the private backend environment and `CHEF_LIVE_META=1`,
then run `python -m unittest discover -s tests -p test_meta_live.py -v`.
The live test sends `片栗粉10g、いや15g。売価1800円に` to Meta, routes the real
proposal through FastAPI validation, explicitly confirms it, recalculates cost,
saves a version to an in-memory repository, checks idempotent replay and records
a scoped correction. It does not connect to Supabase or prove deployed persistence.

Browser live test: with a fresh isolated FastAPI/Meta test server on loopback
port 8101 (same single 10g/1000JPY fixture, test-only demo token), set
`CHEF_LIVE_META_BROWSER=1` and run `npx playwright test meta-live.spec.ts`.
Only that opt-in spec targets real inference. It verifies the actual UI diff,
disabled approval button before chef consent, confirmed save, cost/rate,
correction registration and reload. Normal browser CI uses the fixture backend
and skips this live spec. Never point this test at a production database.

Direct Meta HTTP inference and Codex CLI authentication are separate paths.
The reported direct Responses HTTP 200 resolves neither the CLI's 401 nor its
credential/configuration problem. Do not change the CLI as part of this adapter.

Only dedicated Chef project `dfvryaybdelgjxihdmth` is eligible for later DB tests.
Restaurant operations project `jfaxjgvqfsacprenodkg` is outside scope.
