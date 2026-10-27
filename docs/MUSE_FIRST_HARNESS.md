# Muse-first harness and correction memory

## Objective
Demonstrate a chef correcting a recipe through natural language or voice,
with Muse's actual interpretations visible in the experience. The purpose is
to demonstrate model behavior, **not** to disguise model differences behind
an interchangeable endpoint. No claim about Muse performance until a real
Muse API response has been observed and measured.

## Minimal implementation
1. Capture raw transcript or typed instruction unchanged. A *separate*
   cleaned interpretation may be suggested, but must not overwrite source.
2. Pass current recipe line IDs, chef-facing food names, amounts, units,
   price provenance, and only relevant correction preferences to Muse.
3. Record Muse's raw structured suggestion, unresolved ambiguities and
   alternatives before a deterministic parser/validator touches it.
   Never silently fabricate material IDs, purchasing quotes or confirmation.
4. Surface an understandable diff for chef approval; only the existing
   deterministic mutation engine can commit and calculate costs.
5. When corrected, record the observed phrase, suggested interpretation,
   accepted correction, recipe context and model identifier. Reuse only
   relevant preferences on subsequent requests; never treat corrections as
   unconditional global aliases.

## Provider differentiation
Transport abstraction is useful for temporary non-Muse test calls.
**Prompting, model-native response shape, error handling and multimodal
inputs must remain provider-specific adapters.** When Muse becomes
accessible, establish its actual supported modalities, instruction format,
tool/structured-output behavior, and strengths empirically. Do not assume
Chat Completions compatibility or force Muse through a substitute model's
prompt. Compare identical chef utterances on ambiguous units, substitutions,
corrections and partial ingredient prices, preserving raw outputs and user
acceptance/rejection as evidence.

## Memory storage
Reuse the project's **existing dedicated Supabase PostgreSQL**: small indexed
tables for correction events and optional user-confirmed term preferences,
with recipe/context and model attribution. Retrieve a bounded set of matches
by owner + exact name/normalized phrase/recipe context using indexed SQL;
do not introduce a separate Cloudflare D1 database, embedding endpoint,
RAG framework or vector search without a demonstrated retrieval need.
Correction logs and preferences are separate from immutable recipe
versions. Never leak one user's corrections to another in production.

## Acceptance demo
Chef says "片栗粉10g、いや15g。売価を1800円に". Preserve the
self-correction and ingredient identity. Muse proposes a candidate diff;
chef reviews and confirms; Python updates revision and cost. A deliberately
misheard food name is corrected and that correction becomes a scoped
candidate for the next attempt. Report Muse vs substitute behavior
separately. Fallback model demos are **not** proof of Muse integration.

## Boundary
The test adapter in PR #18 is a temporary way to exercise real model
transport. This document is a product interaction contract, not a demand
to implement production memory, streaming, RAG or large agent libraries
during the hackathon.
