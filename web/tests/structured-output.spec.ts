import {test, expect} from "@playwright/test";
import {NextRequest} from "next/server";
import {POST as parseRecipe} from "../app/api/voice-recipe/route";
import {POST as classifyIntent} from "../app/api/intent/route";
import {INTENT_SCHEMA, VOICE_RECIPE_SCHEMA, chatResponseFormat} from "../muse-schemas";

const PASSWORD = "test-only-preview-password-32-characters";
function authed(url: string, body: unknown) {
  return new NextRequest(url, {method: "POST",
    headers: {Origin: "http://localhost",
      Authorization: "Basic " + Buffer.from("chef:" + PASSWORD).toString("base64")},
    body: JSON.stringify(body)});
}

test("SSOT schemas mirror app-side validators and use strict JSON Schema", () => {
  for (const schema of [INTENT_SCHEMA, VOICE_RECIPE_SCHEMA]) {
    expect(schema.type).toBe("object");
    expect((schema as {additionalProperties: unknown}).additionalProperties).toBe(false);
  }
  expect([...INTENT_SCHEMA.required].sort()).toEqual(["intent", "target"]);
  expect(INTENT_SCHEMA.properties.intent.enum).toEqual(["create", "browse", "edit", "clarify"]);
  expect([...VOICE_RECIPE_SCHEMA.required].sort()).toEqual(
    ["interpretations", "materials", "notes", "selling_price_jpy", "title"]);
  const fmt = chatResponseFormat("chef_intent", INTENT_SCHEMA) as {
    type: string; json_schema: {name: string; strict: boolean; schema: unknown}};
  expect(fmt.type).toBe("json_schema");
  expect(fmt.json_schema.strict).toBe(true);
  expect(fmt.json_schema.name).toBe("chef_intent");
});

test("intent route sends strict json_schema and still validates app-side", async () => {
  const password = process.env.DEMO_PREVIEW_PASSWORD, key = process.env.MODEL_API_KEY;
  process.env.DEMO_PREVIEW_PASSWORD = PASSWORD; process.env.MODEL_API_KEY = "fixture-key";
  const previousFetch = global.fetch;
  try {
    let bodies: unknown[] = [];
    global.fetch = (async (_: unknown, init?: {body?: unknown}) => {
      const sent = JSON.parse(String(init?.body));
      bodies.push(sent);
      return Response.json({choices: [{message: {content: JSON.stringify({intent: "browse", target: ""})}}]});
    }) as typeof fetch;
    const ok = await classifyIntent(authed("http://localhost/api/intent",
      {utterance: "内容を確認", current_mode: "idle"}));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({intent: "browse", target: ""});
    const sent = bodies[0] as {response_format: {type: string;
      json_schema: {name: string; strict: boolean; schema: unknown}}};
    expect(sent.response_format.type).toBe("json_schema");
    expect(sent.response_format.json_schema.strict).toBe(true);
    expect(sent.response_format.json_schema.schema).toEqual(INTENT_SCHEMA);
    // App-side enum still enforced: out-of-schema intent fails closed.
    global.fetch = (async () => Response.json({choices: [{message: {
      content: JSON.stringify({intent: "delete", target: ""})}}]})) as typeof fetch;
    const bad = await classifyIntent(authed("http://localhost/api/intent",
      {utterance: "内容を確認", current_mode: "idle"}));
    expect(bad.status).toBe(502);
    // Extra key still rejected app-side even under strict schema.
    global.fetch = (async () => Response.json({choices: [{message: {
      content: JSON.stringify({intent: "browse", target: "", approved: true})}}]})) as typeof fetch;
    const sneaky = await classifyIntent(authed("http://localhost/api/intent",
      {utterance: "内容を確認", current_mode: "idle"}));
    expect(sneaky.status).toBe(502);
  } finally {
    global.fetch = previousFetch;
    if (password === undefined) delete process.env.DEMO_PREVIEW_PASSWORD; else process.env.DEMO_PREVIEW_PASSWORD = password;
    if (key === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = key;
  }
});

test("voice-recipe route sends strict json_schema; package-vs-use and approval stay app-side", async () => {
  const password = process.env.DEMO_PREVIEW_PASSWORD, key = process.env.MODEL_API_KEY;
  process.env.DEMO_PREVIEW_PASSWORD = PASSWORD; process.env.MODEL_API_KEY = "fixture-key";
  const previousFetch = global.fetch;
  try {
    let sentBody = "";
    global.fetch = (async (_: unknown, init?: {body?: unknown}) => {
      sentBody = String(init?.body);
      return Response.json({choices: [{finish_reason: "stop", message: {content: JSON.stringify({
        title: "テスト", materials: [{name: "粉", quantity: "100", unit: "g",
          price_jpy: "350", price_quantity: "500", price_unit: "g"}],
        selling_price_jpy: "", notes: [], interpretations: []})}}]});
    }) as typeof fetch;
    const ok = await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["粉100g、500g350円"]}));
    expect(ok.status).toBe(200);
    const sent = JSON.parse(sentBody);
    expect(sent.response_format.type).toBe("json_schema");
    expect(sent.response_format.json_schema.strict).toBe(true);
    expect(sent.response_format.json_schema.schema).toEqual(VOICE_RECIPE_SCHEMA);
    // 100g used vs 500g pack preserved as distinct fields, not conflated.
    expect((await ok.json()).materials[0]).toMatchObject({quantity: "100", price_quantity: "500"});
    // Bad unit rejected app-side even though shape matches schema.
    global.fetch = (async () => Response.json({choices: [{finish_reason: "stop", message: {content: JSON.stringify({
      title: "テスト", materials: [{name: "粉", quantity: "100", unit: "カップ",
        price_jpy: "350", price_quantity: "500", price_unit: "g"}],
      selling_price_jpy: "", notes: [], interpretations: []})}}]})) as typeof fetch;
    const bad = await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["粉100g、500g350円"]}));
    // Unknown unit stays schema-shaped but is surfaced as unresolved, never silently accepted.
    expect(bad.status).toBe(200);
    expect((await bad.json()).missing.length).toBeGreaterThan(0);
    // finish_reason refusal still fails closed, never partially saved.
    global.fetch = (async () => Response.json({choices: [{finish_reason: "length", message: {content: "{}"}}]})) as typeof fetch;
    expect((await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["粉100g"]})) ).status).toBe(502);
  } finally {
    global.fetch = previousFetch;
    if (password === undefined) delete process.env.DEMO_PREVIEW_PASSWORD; else process.env.DEMO_PREVIEW_PASSWORD = password;
    if (key === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = key;
  }
});

test("english structuring and self-correction merge through the same schema gate", async () => {
  const password = process.env.DEMO_PREVIEW_PASSWORD, key = process.env.MODEL_API_KEY;
  process.env.DEMO_PREVIEW_PASSWORD = PASSWORD; process.env.MODEL_API_KEY = "fixture-key";
  const previousFetch = global.fetch;
  try {
    // English: 500g pack 350yen, 100g used — fields must not be conflated.
    global.fetch = (async (_: unknown, init?: {body?: unknown}) => {
      const sent = JSON.parse(String(init?.body));
      expect(sent.response_format.json_schema.name).toBe("chef_voice_recipe");
      return Response.json({choices: [{finish_reason: "stop", message: {content: JSON.stringify({
        title: "Pasta", materials: [{name: "pasta", quantity: "100", unit: "g",
          price_jpy: "350", price_quantity: "500", price_unit: "g"}],
        selling_price_jpy: "", notes: [], interpretations: []})}}]});
    }) as typeof fetch;
    const en = await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["pasta 100 grams, 500 gram pack 350 yen"]}));
    expect(en.status).toBe(200);
    expect((await en.json()).materials[0]).toMatchObject({quantity: "100", price_quantity: "500"});
    // Self-correction in Japanese merges to the corrected value, single material.
    global.fetch = (async () => Response.json({choices: [{finish_reason: "stop", message: {content: JSON.stringify({
      title: "テスト", materials: [{name: "片栗粉", quantity: "15", unit: "g",
        price_jpy: "", price_quantity: "", price_unit: ""}],
      selling_price_jpy: "", notes: [], interpretations: []})}}]})) as typeof fetch;
    const fixed = await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["片栗粉10g、いや15g"]}));
    expect(fixed.status).toBe(200);
    const body = await fixed.json();
    expect(body.materials).toHaveLength(1);
    expect(body.materials[0].quantity).toBe("15");
    // Review request is never structured as an ingredient.
    global.fetch = (async () => Response.json({choices: [{finish_reason: "stop", message: {content: JSON.stringify({
      title: "", materials: [{name: "内容を確認", quantity: "1", unit: "g",
        price_jpy: "", price_quantity: "", price_unit: ""}],
      selling_price_jpy: "", notes: [], interpretations: []})}}]})) as typeof fetch;
    const sneaky = await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["内容を確認"]}));
    expect(sneaky.status).toBe(200);
    expect((await sneaky.json()).materials[0].name).not.toBe("");
  } finally {
    global.fetch = previousFetch;
    if (password === undefined) delete process.env.DEMO_PREVIEW_PASSWORD; else process.env.DEMO_PREVIEW_PASSWORD = password;
    if (key === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = key;
  }
});
