# Chef AI Workspace

**From a chef's idea to a structured, cost-aware recipe — through natural conversation.**

Chef AI Workspace is an AI-powered recipe development workspace designed for professional chefs and independent restaurant owners.

Instead of manually entering ingredients, quantities, purchase prices, and recipe details into multiple forms, chefs can simply describe what they want to cook.

The AI transforms their ideas into structured, editable recipes with estimated food costs.

## The Problem

Professional recipe management systems require extensive manual data entry.

For busy chefs, registering ingredients, quantities, supplier information, and prices can become more work than creating the dish itself.

The result: valuable recipes and ideas often remain undocumented.

## Our Approach

**Make recipe creation feel like a conversation, not data entry.**

A chef can say:

> I want to create a shrimp linguine. Use 90 grams of pasta, three shrimp, some tomatoes, white wine, garlic, and olive oil. Each shrimp costs around 120 yen. I want to sell it for 1,800 yen.

The workspace interprets the request, structures the ingredients, estimates missing quantities and costs, and builds an editable recipe.

The chef can then say:

- Add one more shrimp.
- Change the shrimp price to 150 yen each.
- Increase the estimated total cost by 50 yen.
- Save this as another version.

The recipe evolves through conversation.

## Core Design Principles

### 1. Recipe-Centered State

Structured recipe data is the source of truth, rather than the conversation history alone.

### 2. Explicit Data Confidence

Recipe information is distinguished as:

- **Confirmed:** Explicitly provided or confirmed by the chef.
- **Assumed:** Estimated or inferred by the AI.
- **Unresolved:** Not yet sufficiently determined.

AI assumptions must never be presented as confirmed facts.

### 3. Minimal Interruptions

The AI asks questions only when clarification has meaningful value. Otherwise, it continues with clearly identified assumptions.

### 4. AI-Assisted, Deterministic Execution

AI interprets natural language and proposes recipe changes.

Application logic validates those changes, performs calculations, and manages persistence.

### 5. Conversation-First Interaction

Natural language and voice are the primary interaction methods. Structured forms are not required for normal recipe creation.

## Meta AI Integration

The audio pipeline separates three responsibilities: Web Audio captures speech,
the server sends WAV audio to **Muse Voice Transcribe**, and **Muse Spark**
interprets professional recipe meaning and self-corrections. This keeps the
audio input contract reusable by a future native client. Browser speech
recognition is no longer required.

Transcription creates input, never authorization. The chef reviews the draft
or proposed changes and explicitly approves saving through the existing Human
Gate. Recordings are sent to Meta and are not stored by the application.

Cost calculation and data validation remain deterministic application responsibilities.

See [ADR-007](docs/ADR_007_MUSE_VOICE_INPUT_BOUNDARY.md) for the verified API
contract and limits. [Live Web acceptance](docs/VOICE_ACCEPTANCE.md) verified
Japanese synthetic speech through actual Voice/Spark APIs, explicit approval,
dedicated Supabase persistence and reload. This is a Web hackathon submission;
native apps and physical smartphone testing are outside this change's scope.
The test does not establish general recognition accuracy in kitchen noise.

## Project Background

This project is inspired by real operational challenges encountered while developing and using restaurant recipe and food-cost management software.

Chef AI Workspace is an independent hackathon project. Its implementation does not depend on the existing private Ricetta-OS system.

## Ingredient and procurement assistance — implementation design

Reusable ingredient records, supplier-specific purchase terms, price-change
awareness, a notification bell and source-backed alternative purchasing
suggestions are implemented (M1–M7) as domain paths behind the demo API.
Fixture layers are verified; live-DB, live-inference and live-retrieval runs
are explicitly unverified. Voice transcription alone does not satisfy them.

The Web UI exposes voice registration, the proposal diff, the cost view,
the notification bell and sourcing suggestions. Ingredient reuse assistance
(search + ingredient-assist + ledger confirm) is a demo-API flow and is not
wired into the voice registration UI: saving from voice creates unlinked
material lines, and linking needs the explicit assist + confirm steps
(see the demo script).

See [ADR-009](docs/ADR_009_INGREDIENT_PROCUREMENT_ASSISTANCE.md),
[detailed design](docs/INGREDIENT_PRICE_DESIGN.md),
[implementation checklist](docs/IMPLEMENTATION_PLAN_MASTER_PRICE.md), and
[alternating Muse/Codex handoff](docs/MUSE_CODEX_HANDOFF.md).
Price-check scheduling, thresholds and external retrieval choices still require
explicit design decisions; no automatic monitoring or purchasing is enabled by
these documents.

## Setup & run (local development)

Prerequisites: Python 3.12, Node.js 22.

```bash
pip install -r requirements-api.txt
SUPABASE_URL=https://dfvryaybdelgjxihdmth.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<server-only> \
uvicorn chef_ai_workspace.deploy_server:app --port 8000
cd web && npm install && npm run dev
```

Verified boot: backend imports, `GET /health` returns 200 (liveness only).

Environment (all server-only, never `NEXT_PUBLIC_`):

| Variable | Used by | Purpose |
|---|---|---|
| `SUPABASE_URL` | backend | Fixed to the Chef AI project; other hosts fail closed |
| `SUPABASE_SERVICE_ROLE_KEY` | backend | Server-side persistence |
| `DEMO_OWNER_ID` | backend only | Isolated demo owner (UUID; required together with the token) |
| `DEMO_ACCESS_TOKEN` | backend + web (same value) | Demo credential (≥ 24 chars). The web proxy (`web/app/api/proxy.ts`) returns 503 without it; the backend (`server_config.py`) requires it together with `DEMO_OWNER_ID`. Set the identical value in both runtimes |
| `MODEL_API_KEY` | backend/Next | Meta inference (server-only) |
| `FASTAPI_BASE_URL` | web | Trusted backend origin |
| `DEMO_PREVIEW_PASSWORD` | web | Preview gate (≥ 24 ASCII chars) |

Checks: `python3 -m unittest discover -s tests`,
`./web/node_modules/.bin/tsc --noEmit -p web/tsconfig.json`,
`npm run build --prefix web`.

## Verification status and limits

See [M8 acceptance](docs/M8_ACCEPTANCE.md) for the A1–A8 verdicts with
evidence. Passing fixtures are not quoted as live verification:
real-DB writes, external price retrieval, live Meta inference and real-voice
runs are unverified. No automatic price adoption, supplier switching,
purchasing, monitoring schedules or thresholds are enabled.

## Development status

Early development — Meta Global AI Developer Hackathon 2026.
