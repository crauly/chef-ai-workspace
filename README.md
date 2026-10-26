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

Meta AI models will power meaningful parts of the recipe interpretation and editing workflow.

Cost calculation and data validation remain deterministic application responsibilities.

## Project Background

This project is inspired by real operational challenges encountered while developing and using restaurant recipe and food-cost management software.

Chef AI Workspace is an independent hackathon project. Its implementation does not depend on the existing private Ricetta-OS system.

## Status

Early development — Meta Global AI Developer Hackathon 2026.
