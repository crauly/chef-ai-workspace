# Chef AI Workspace — Why this matters

## The invisible work behind a restaurant dish

A chef sees a plate. A restaurant operator must also see the cost of every
ingredient, current purchase price, portion size, selling price, margin and
the effect of every adjustment. In a small independent restaurant, the same
person often designs dishes, purchases ingredients, cooks, serves guests and
runs the business. Accurate costing is essential, but maintaining it is
tedious and competes with the time available to cook.

**A concrete example from a chef's experience:** one small tomato garnish
portion can cost approximately ¥8 in a cheaper season and ¥20 when prices
rise. Adding a second portion may feel trivial on the plate, yet the
incremental cost can materially change the margin of a high-volume dish.
These are illustrative firsthand figures, **not independently verified
market-price data**. Across many ingredients and dishes, tiny choices
accumulate. The problem is not that chefs do not know costing matters;
it is that they lack the time and frictionless tools to do it consistently.
The founder's perspective comes from years of tracking food costs down to
the yen. Do not claim that a measured percentage of restaurants fail to
track costs without external survey evidence.

## What the application changes

Instead of forcing the chef to interrupt their work, find a spreadsheet,
look up every line and calculate again, Chef AI Workspace invites a natural
instruction:

> "片栗粉を10グラム…いや15グラムに。売価は1,800円。"
>
> "Make the potato starch 10 grams—no, 15. Set the selling price to ¥1,800."

A model proposes which recipe fields should change. The interface **shows
the proposed diff and any uncertainty**; the chef accepts or corrects it.
A deterministic calculation engine then recomputes cost and cost rate,
while versioned persistence retains a reproducible record. The display
uses the chef's food name, not a supplier's internal product classification.

The difference is not voice-to-text alone. It is **natural language to
auditable, validated business actions**, reducing the mental and clerical
distance between creative cooking and cost-aware decision-making.

## Why Muse is central

The hackathon demonstration should expose what **Muse actually does**:
interpreting a chef's self-correction, finding the relevant ingredient
among recipe lines, handling missing price facts without inventing them,
and returning a proposed action that the user can inspect. A small harness
preserves the raw instruction, retrieves relevant food names and any
confirmed correction preferences, validates proposed IDs/units/values and
requires human approval. The algorithm—not an LLM—does arithmetic.

Do not ascribe unobserved capabilities or benchmark performance to Muse.
The API integration is currently blocked by an authentication error;
a fallback model may prove the UI-to-data workflow, but **cannot be
represented as a Muse-powered demo**. Once accessible, observe Muse's
actual response formats, error modes and strengths and adapt the
model-specific harness accordingly.

## Four things a judge should understand

1. **Hidden burden:** price volatility and portion decisions quietly
   determine the margin of a dish. The burden is unusually intense for
   small independent operators without dedicated back-office staff.
2. **Interaction:** the chef speaks or types a naturally phrased change,
   including corrections and informal food vocabulary.
3. **Trust:** the proposed edit is visible before approval; unknown
   purchase prices are not fabricated; reproducible calculations and
   revision records distinguish this from a chat answer.
4. **Reach:** the reusable idea is a guarded voice/natural-language-to-
   structured-action harness. Inventory counts, small wholesalers and,
   with substantially stronger safety and regulatory safeguards, clinical
   documentation are possible **future application domains**—not existing
   product features or claims of medical readiness.

## Three-minute demo narrative (target timings)

- **0:00–0:30 — Invisible problem.** Show a modest tomato garnish and a
  visible example of ¥8 vs ¥20 per portion. Say clearly that the example
  illustrates seasonal variation from chef experience. Show how one
  incremental decision changes cost and margin.
- **0:30–1:00 — Chef workflow.** A real recipe with named ingredients,
  current prices and selling price. Explain that traditional manual
  updates repeatedly interrupt the work.
- **1:00–2:05 — Muse in action.** Give a natural instruction with a
  self-correction. Show Muse's raw/structured proposed changes; correct
  or clarify if needed, then explicitly approve. Never simulate this
  while calling it live Muse.
- **2:05–2:35 — Measurable result.** Show the changed recipe, recalculated
  cost/cost rate and persisted revision. Highlight that arithmetic is
  deterministic and uncertain values stay marked.
- **2:35–3:00 — Bigger insight.** This interface connects natural
  language to verifiable operational records. Mention potential use
  in small-business inventory workflows without suggesting those are
  implemented.

If Muse access remains blocked when recording, accurately label any
fallback or offline proposal; do not fabricate successful Muse inference.

## Application / submission copy (English)

**Problem.** Independent restaurant chefs make constant decisions about
portions, substitutions and seasonal ingredients, yet every decision
affects food cost. Maintaining accurate, item-level costs across recipes
takes time many small teams cannot spare.

**Idea.** Chef AI Workspace turns conversational recipe changes into
reviewable, structured actions. A chef can correct themselves mid-sentence;
the AI proposes an exact edit, while a deterministic engine validates
inputs, recalculates food cost and saves versioned results. Corrections
can become scoped knowledge to improve future interpretation.

**Why it matters.** The product makes invisible operating costs visible
at the moment of creative decision-making. Its larger insight is a
human-approved, auditable harness for converting natural-language
instructions into dependable records—potentially useful beyond
restaurants.

**Muse integration status.** [Replace this bracketed field with
the verified Muse integration result when the demo is prepared.]
