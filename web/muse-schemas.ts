// SSOT for Meta Muse Spark Structured Output (Phase C).
// JSON Schema shapes mirror the app-side validators in
// web/app/api/intent/route.ts and web/app/api/voice-recipe/route.ts.
// Structured Output guarantees shape only; all semantic checks
// (units, decimals, package-vs-use, approval) stay in parse() and downstream
// Human Gate logic. Schemas intentionally omit maxLength-style hints:
// length limits remain enforced app-side.

export const INTENT_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["create", "browse", "edit", "clarify"] },
    target: { type: "string" },
  },
  required: ["intent", "target"],
  additionalProperties: false,
} as const;

const MATERIAL_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    quantity: { type: "string" },
    unit: { type: "string" },
    price_jpy: { type: "string" },
    price_quantity: { type: "string" },
    price_unit: { type: "string" },
    // Spoken purchase source (store, market, brand outlet). Empty string
    // when unstated; never inferred. Displayed on the draft card and kept
    // through review; recipe lines carry no supplier column, so saving keeps
    // the manufacturer inside name and never drops this text silently.
    supplier: { type: "string" },
  },
  required: ["name", "quantity", "unit", "price_jpy", "price_quantity", "price_unit", "supplier"],
  additionalProperties: false,
};

const INTERPRETATION_SCHEMA = {
  type: "object",
  properties: {
    source: { type: "string" },
    suggestion: { type: "string" },
    reason: { type: "string" },
  },
  required: ["source", "suggestion", "reason"],
  additionalProperties: false,
};

export const VOICE_RECIPE_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    materials: { type: "array", items: MATERIAL_SCHEMA },
    selling_price_jpy: { type: "string" },
    notes: { type: "array", items: { type: "string" } },
    interpretations: { type: "array", items: INTERPRETATION_SCHEMA },
  },
  required: ["title", "materials", "selling_price_jpy", "notes", "interpretations"],
  additionalProperties: false,
} as const;

export function chatResponseFormat(schemaName: string, schema: unknown) {
  // Verified Chat Completions shape only. Responses API text.format is
  // intentionally NOT emitted here until a live Responses acceptance is recorded.
  return {
    type: "json_schema",
    json_schema: { name: schemaName, strict: true, schema },
  };
}
