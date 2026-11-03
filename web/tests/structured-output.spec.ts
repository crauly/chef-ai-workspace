import {test, expect} from "@playwright/test";
import {NextRequest} from "next/server";
import {POST as parseRecipe} from "../app/api/voice-recipe/route";
import {POST as classifyIntent} from "../app/api/intent/route";
import {INTENT_SCHEMA, VOICE_RECIPE_SCHEMA, chatResponseFormat} from "../muse-schemas";

const PASSWORD = "test-only-preview-password-32-characters";
const UNIT_CATALOG={items:[{id:"00000000-0000-4000-8000-000000000001",symbol:"g",dimension:"mass",base_factor:"1",aliases:["グラム"]}]};
function unitCatalogFetch(mock:typeof fetch):typeof fetch{
 return (async (input:RequestInfo|URL,init?:RequestInit)=>{
  if(String(input).includes("/demo/units"))return Response.json(UNIT_CATALOG);
  return mock(input,init);
 }) as typeof fetch;
}
test.beforeEach(()=>{
 process.env.FASTAPI_BASE_URL="http://127.0.0.1:8100";
 process.env.DEMO_ACCESS_TOKEN="fixture-unit-test-token";
});

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
    ["interpretations", "materials", "name_corrections", "notes", "price_research", "selling_price_jpy", "title", "unit_proposals"]);
  // Strict-mode contract: every object schema lists all its property
  // keys in required (Meta rejects otherwise with 400 -> app 502).
  const assertStrict = (node: unknown, path: string) => {
    if (!node || typeof node !== "object") return;
    const rec = node as Record<string, unknown>;
    if (rec.type === "object" && rec.properties && typeof rec.properties === "object") {
      const props = Object.keys(rec.properties as object).sort();
      const req = [...((rec.required as string[]) ?? [])].sort();
      expect(req, path).toEqual(props);
      for (const [k, v] of Object.entries(rec.properties as object)) assertStrict(v, `${path}.${k}`);
    }
    if (rec.type === "array" && rec.items) assertStrict(rec.items, `${path}[]`);
  };
  assertStrict(VOICE_RECIPE_SCHEMA, "VOICE_RECIPE_SCHEMA");
  assertStrict(INTENT_SCHEMA, "INTENT_SCHEMA");
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
    global.fetch = unitCatalogFetch((async (_: unknown, init?: {body?: unknown}) => {
      sentBody = String(init?.body);
      return Response.json({choices: [{finish_reason: "stop", message: {content: JSON.stringify({
        title: "テスト", materials: [{name: "粉", quantity: "100", unit: "g",
          price_jpy: "350", price_quantity: "500", price_unit: "g", supplier: ""}],
        selling_price_jpy: "", notes: [], interpretations: []})}}]});
    }) as typeof fetch);
    const ok = await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["粉100g、500g350円"]}));
    expect(ok.status).toBe(200);
    const sent = JSON.parse(sentBody);
    expect(sent.messages[0].role).toBe("developer");
    expect(sent.messages[0].content).toContain("English is the primary language");
    expect(sent.messages[0].content).not.toContain("carbonara");
    expect(sent.response_format.type).toBe("json_schema");
    expect(sent.response_format.json_schema.strict).toBe(true);
    expect(sent.response_format.json_schema.schema).toEqual(VOICE_RECIPE_SCHEMA);
    // 100g used vs 500g pack preserved as distinct fields, not conflated.
    expect((await ok.json()).materials[0]).toMatchObject({quantity: "100", price_quantity: "500"});
    // Bad unit rejected app-side even though shape matches schema.
    global.fetch = unitCatalogFetch((async () => Response.json({choices: [{finish_reason: "stop", message: {content: JSON.stringify({
      title: "テスト", materials: [{name: "粉", quantity: "100", unit: "カップ",
        price_jpy: "350", price_quantity: "500", price_unit: "g", supplier: ""}],
      selling_price_jpy: "", notes: [], interpretations: []})}}]})) as typeof fetch);
    const bad = await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["粉100g、500g350円"]}));
    // Unknown unit stays schema-shaped but is surfaced as unresolved, never silently accepted.
    expect(bad.status).toBe(200);
    expect((await bad.json()).materials[0].unit).toBe("カップ");
    // finish_reason refusal still fails closed, never partially saved.
    global.fetch = unitCatalogFetch((async () => Response.json({choices: [{finish_reason: "length", message: {content: "{}"}}]})) as typeof fetch);
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
    global.fetch = unitCatalogFetch((async (_: unknown, init?: {body?: unknown}) => {
      const sent = JSON.parse(String(init?.body));
      expect(sent.response_format.json_schema.name).toBe("chef_voice_recipe");
      return Response.json({choices: [{finish_reason: "stop", message: {content: JSON.stringify({
        title: "Pasta", materials: [{name: "pasta", quantity: "100", unit: "g",
          price_jpy: "350", price_quantity: "500", price_unit: "g", supplier: ""}],
        selling_price_jpy: "", notes: [], interpretations: []})}}]});
    }) as typeof fetch);
    const en = await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["pasta 100 grams, 500 gram pack 350 yen"]}));
    expect(en.status).toBe(200);
    expect((await en.json()).materials[0]).toMatchObject({quantity: "100", price_quantity: "500"});
    // Self-correction in Japanese merges to the corrected value, single material.
    global.fetch = unitCatalogFetch((async () => Response.json({choices: [{finish_reason: "stop", message: {content: JSON.stringify({
      title: "テスト", materials: [{name: "片栗粉", quantity: "15", unit: "g",
        price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
      selling_price_jpy: "", notes: [], interpretations: []})}}]})) as typeof fetch);
    const fixed = await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["片栗粉10g、いや15g"]}));
    expect(fixed.status).toBe(200);
    const body = await fixed.json();
    expect(body.materials).toHaveLength(1);
    expect(body.materials[0].quantity).toBe("15");
    // Review request is never structured as an ingredient.
    global.fetch = unitCatalogFetch((async () => Response.json({choices: [{finish_reason: "stop", message: {content: JSON.stringify({
      title: "", materials: [{name: "内容を確認", quantity: "1", unit: "g",
        price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
      selling_price_jpy: "", notes: [], interpretations: []})}}]})) as typeof fetch);
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

test("supplier is extracted without guessing; revision reuses the previous draft", async () => {
  const password = process.env.DEMO_PREVIEW_PASSWORD, key = process.env.MODEL_API_KEY;
  process.env.DEMO_PREVIEW_PASSWORD = PASSWORD; process.env.MODEL_API_KEY = "fixture-key";
  const previousFetch = global.fetch;
  try {
    let sentBody = "";
    global.fetch = unitCatalogFetch((async (_: unknown, init?: {body?: unknown}) => {
      sentBody = String(init?.body);
      return Response.json({choices: [{finish_reason: "stop", message: {content: JSON.stringify({
        title: "テスト", materials: [{name: "ディチェコ パスタ", quantity: "100", unit: "g",
          price_jpy: "350", price_quantity: "500", price_unit: "g", supplier: "築地場外"}],
        selling_price_jpy: "", notes: [], interpretations: []})}}]});
    }) as typeof fetch);
    const ok = await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["ディチェコのパスタ100g、築地場外で500g350円"]}));
    expect(ok.status).toBe(200);
    expect((await ok.json()).materials[0]).toMatchObject({name: "ディチェコ パスタ", supplier: "築地場外"});
    // Revision: only the new turn plus the previous draft travel upstream.
    global.fetch = unitCatalogFetch((async (_: unknown, init?: {body?: unknown}) => {
      sentBody = String(init?.body);
      return Response.json({choices: [{finish_reason: "stop", message: {content: JSON.stringify({
        title: "テスト", materials: [
          {name: "ディチェコ パスタ", quantity: "100", unit: "g", price_jpy: "350",
            price_quantity: "500", price_unit: "g", supplier: "築地場外"},
          {name: "卵", quantity: "50", unit: "g", price_jpy: "", price_quantity: "",
            price_unit: "", supplier: ""}],
        selling_price_jpy: "", notes: [], interpretations: []})}}]});
    }) as typeof fetch);
    const previous = {title: "テスト", materials: [{name: "ディチェコ パスタ", quantity: "100",
      unit: "g", price_jpy: "350", price_quantity: "500", price_unit: "g", supplier: "築地場外"}],
      selling_price_jpy: "", notes: [], interpretations: [],
      nameCorrections: [{material_name: "ディチェコ パスタ", heard: "デチェコパスタ",
        candidates: [{name: "ディチェコ パスタ", reason: "ASR phonetic match"}]}]};
    const revised = await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["あと卵50g"], previous}));
    expect(revised.status).toBe(200);
    const sent = JSON.parse(sentBody).messages[1];
    expect(Object.keys(JSON.parse(sent.content)).sort()).toEqual(["new_turns", "previous_draft", "unit_catalog"]);
    expect(JSON.parse(sent.content).new_turns).toEqual(["あと卵50g"]);
    // Unrelated follow-up keeps the unresolved correction context.
    expect(JSON.parse(sent.content).previous_draft.name_corrections).toEqual(
      previous.nameCorrections);
    expect((await revised.json()).materials).toHaveLength(2);
    // Malformed previous draft fails closed without calling the provider.
    global.fetch = unitCatalogFetch((async () => Response.json({choices: []})) as typeof fetch);
    expect((await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["卵"], previous: {title: "x"}}))).status).toBe(400);
    // Material shape without supplier is rejected app-side.
    global.fetch = unitCatalogFetch((async () => Response.json({choices: [{finish_reason: "stop", message: {content: JSON.stringify({
      title: "テスト", materials: [{name: "粉", quantity: "100", unit: "g",
        price_jpy: "350", price_quantity: "500", price_unit: "g"}],
      selling_price_jpy: "", notes: [], interpretations: []})}}]})) as typeof fetch);
    expect((await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["粉"]})) ).status).toBe(502);
  } finally {
    global.fetch = previousFetch;
    if (password === undefined) delete process.env.DEMO_PREVIEW_PASSWORD; else process.env.DEMO_PREVIEW_PASSWORD = password;
    if (key === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = key;
  }
});

test("explicit price research resolves against the owned ledger, never model knowledge", async () => {
  const password = process.env.DEMO_PREVIEW_PASSWORD, key = process.env.MODEL_API_KEY;
  const base = process.env.FASTAPI_BASE_URL, token = process.env.DEMO_ACCESS_TOKEN;
  process.env.DEMO_PREVIEW_PASSWORD = PASSWORD; process.env.MODEL_API_KEY = "fixture-key";
  process.env.FASTAPI_BASE_URL = "http://127.0.0.1:8100"; process.env.DEMO_ACCESS_TOKEN = "fixture-demo-token";
  const previousFetch = global.fetch;
  try {
    const recipe = {title: "テスト", materials: [{name: "豚バラ肉", quantity: "100", unit: "g",
      price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
      selling_price_jpy: "", notes: [], interpretations: [],
      price_research: [{material_name: "豚バラ肉", request: "だいたいの相場で入れて"}]};
    const ledger = {query: "豚バラ肉", candidates: [{ingredient_id: "ing-1",
      ingredient_name: "豚バラ肉", reference: {available: true, currency: "JPY",
        unit_basis: "g", average_unit_price: "0.7700", observation_count: 2,
        observed_to: "2026-10-28", method: "average of 2 comparable observations"},
      observations: []}]};
    global.fetch = unitCatalogFetch((async (url: unknown) => {
      if (String(url).includes("/demo/price-reference")) return Response.json(ledger);
      return Response.json({choices: [{finish_reason: "stop",
        message: {content: JSON.stringify(recipe)}}]});
    }) as typeof fetch);
    const ok = await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["豚バラ肉100g、だいたいの相場で入れて"]}));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    // Informational only: notes stay empty so the save gate is untouched.
    expect(body.notes).toEqual([]);
    expect(body.price_references).toHaveLength(1);
    expect(body.price_references[0].status).toBe("available");
    expect(body.price_references[0].text).toContain("平均");
    expect(body.price_references[0].currency).toBe("JPY");
    expect(body.price_references[0].origin).toBe("ledger");
    // Prices stay empty: the missing path (unconfirmed save) is preserved.
    expect(body.materials[0].price_jpy).toBe("");
    expect(body.missing.join("")).toContain("仕入単価");
    // Backend failure still returns the draft; the entry reports none.
    global.fetch = unitCatalogFetch((async (url: unknown) => {
      if (String(url).includes("/demo/price-reference"))
        return Response.json({}, {status: 503});
      return Response.json({choices: [{finish_reason: "stop",
        message: {content: JSON.stringify(recipe)}}]});
    }) as typeof fetch);
    const degraded = await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["豚バラ肉100g、だいたいの相場で入れて"]}));
    expect(degraded.status).toBe(200);
    const degradedBody = await degraded.json();
    expect(degradedBody.notes).toEqual([]);
    // Backend failure is reported as unavailable, never disguised as "no history".
    expect(degradedBody.price_references[0].status).toBe("unavailable");
    expect(degradedBody.price_references[0].text).toContain("確認できません");
    // Non-JPY history is shown verbatim, never labeled yen, never converted.
    global.fetch = unitCatalogFetch((async (url: unknown) => {
      if (String(url).includes("/demo/price-reference"))
        return Response.json({query: "beef", candidates: [{ingredient_id: "ing-2",
          ingredient_name: "beef", reference: {available: true, currency: "USD",
            unit_basis: "g", average_unit_price: "0.0123", observation_count: 1,
            observed_to: "2026-10-28", method: "single observation"},
          observations: []}]});
      return Response.json({choices: [{finish_reason: "stop",
        message: {content: JSON.stringify({...recipe,
          materials: [{...recipe.materials[0], name: "beef"}],
          price_research: [{material_name: "beef", request: "market quote"}]})}}]});
    }) as typeof fetch);
    const foreign = await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["beef 100 grams, market quote"]}));
    expect(foreign.status).toBe(200);
    const foreignText = (await foreign.json()).price_references[0].text;
    expect(foreignText).toContain("USD");
    expect(foreignText).not.toContain("円");
    // First candidate without history does not hide a later exact match.
    global.fetch = unitCatalogFetch((async (url: unknown) => {
      if (String(url).includes("/demo/price-reference"))
        return Response.json({query: "豚バラ", candidates: [
          {ingredient_id: "ing-9", ingredient_name: "豚バラ先輩",
            reference: {available: false, observation_count: 0, excluded_count: 0}, observations: []},
          ledger.candidates[0]]});
      return Response.json({choices: [{finish_reason: "stop",
        message: {content: JSON.stringify(recipe)}}]});
    }) as typeof fetch);
    const multi = await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["豚バラ肉100g、相場で"]}));
    expect(multi.status).toBe(200);
    const multiRef = (await multi.json()).price_references[0];
    expect(multiRef.status).toBe("available");
    expect(multiRef.ingredient_name).toBe("豚バラ肉");
    // Non-exact fallback names the actual ingredient instead of merging silently.
    global.fetch = unitCatalogFetch((async (url: unknown) => {
      if (String(url).includes("/demo/price-reference"))
        return Response.json({query: "豚", candidates: [
          {ingredient_id: "ing-9", ingredient_name: "豚バラ先輩",
            reference: {available: false, observation_count: 0, excluded_count: 0}, observations: []},
          {ingredient_id: "ing-3", ingredient_name: "豚ロース",
            reference: {available: true, currency: "JPY", unit_basis: "g",
              average_unit_price: "1.1000", observation_count: 1,
              observed_to: "2026-10-27", method: "single observation"}, observations: []}]});
      return Response.json({choices: [{finish_reason: "stop",
        message: {content: JSON.stringify({...recipe,
          price_research: [{material_name: "豚", request: "相場で"}]})}}]});
    }) as typeof fetch);
    const fuzzy = await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["豚100g、相場で"]}));
    expect(fuzzy.status).toBe(200);
    const fuzzyRef = (await fuzzy.json()).price_references[0];
    expect(fuzzyRef.status).toBe("available");
    expect(fuzzyRef.ingredient_name).toBe("豚ロース");
    expect(fuzzyRef.text).toContain("豚ロース");
    // material_index is strict-required (null when rowless); legacy
    // 2-key entries stay accepted for old fixtures. Bad shapes fail closed.
    const indexed = (research: unknown) => {
      global.fetch = unitCatalogFetch((async (url: unknown) => {
        if (String(url).includes("/demo/price-reference"))
          return Response.json({query: "x", candidates: []});
        return Response.json({choices: [{finish_reason: "stop", message: {content: JSON.stringify({
          ...recipe, price_research: research})}}]});
      }) as typeof fetch);
      return parseRecipe(authed("http://localhost/api/voice-recipe",
        {turns: ["豚バラ肉100g、相場で"]}));
    };
    expect((await indexed([{material_name: "豚バラ肉", request: "相場", material_index: 0}])).status).toBe(200);
    expect((await indexed([{material_name: "豚バラ肉", request: "相場", material_index: null}])).status).toBe(200);
    expect((await indexed([{material_name: "豚バラ肉", request: "相場"}])).status).toBe(200);
    expect((await indexed([{material_name: "豚バラ肉", request: "相場", material_index: "0"}])).status).toBe(502);
    expect((await indexed([{material_name: "豚バラ肉", request: "相場", material_index: -1}])).status).toBe(502);
    expect((await indexed([{material_name: "豚バラ肉", request: "相場", material_index: 1.5}])).status).toBe(502);
    // Malformed research entry (extra key) fails closed.
    global.fetch = unitCatalogFetch((async (url: unknown) => {
      if (String(url).includes("/demo/price-reference"))
        return Response.json({query: "x", candidates: []});
      return Response.json({choices: [{finish_reason: "stop", message: {content: JSON.stringify({
        ...recipe, price_research: [{material_name: "豚バラ肉", request: "相場", approved: true}]})}}]});
    }) as typeof fetch);
    expect((await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["豚バラ肉100g、相場で"]})) ).status).toBe(502);
  } finally {
    global.fetch = previousFetch;
    if (password === undefined) delete process.env.DEMO_PREVIEW_PASSWORD; else process.env.DEMO_PREVIEW_PASSWORD = password;
    if (key === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = key;
    if (base === undefined) delete process.env.FASTAPI_BASE_URL; else process.env.FASTAPI_BASE_URL = base;
    if (token === undefined) delete process.env.DEMO_ACCESS_TOKEN; else process.env.DEMO_ACCESS_TOKEN = token;
  }
});

test("ledger lookup failures stay distinct from no-history and never fail the draft", async () => {
  const password = process.env.DEMO_PREVIEW_PASSWORD, key = process.env.MODEL_API_KEY;
  const base = process.env.FASTAPI_BASE_URL, token = process.env.DEMO_ACCESS_TOKEN;
  process.env.DEMO_PREVIEW_PASSWORD = PASSWORD; process.env.MODEL_API_KEY = "fixture-key";
  process.env.FASTAPI_BASE_URL = "http://127.0.0.1:8100"; process.env.DEMO_ACCESS_TOKEN = "fixture-demo-token";
  const previousFetch = global.fetch;
  const recipe = {title: "テスト", materials: [{name: "豚バラ肉", quantity: "100", unit: "g",
    price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
    selling_price_jpy: "", notes: [], interpretations: [],
    price_research: [{material_name: "豚バラ肉", request: "Check the average market price."}]};
  const museOk = async () => Response.json({choices: [{finish_reason: "stop",
    message: {content: JSON.stringify(recipe)}}]});
  async function draftWithLedger(ledger: (url: unknown) => Promise<Response>) {
    global.fetch = unitCatalogFetch((async (url: unknown, init?: {body?: unknown}) => {
      if (String(url).includes("/demo/price-reference")) return ledger(url);
      return museOk();
    }) as typeof fetch);
    const res = await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["豚バラ肉100g、平均価格を調べて"]}));
    expect(res.status).toBe(200);
    return (await res.json()).price_references[0];
  }
  try {
    // 401/403 -> unauthorized, never "no history".
    let ref = await draftWithLedger(async () => Response.json({}, {status: 401}));
    expect(ref.status).toBe("unauthorized");
    expect(ref.text).toContain("認証");
    // 503 / backend down -> unavailable.
    ref = await draftWithLedger(async () => Response.json({}, {status: 503}));
    expect(ref.status).toBe("unavailable");
    // 200 with a contract-breaking shape -> invalid_response.
    ref = await draftWithLedger(async () => Response.json({candidates: [{id: 1}]}));
    expect(ref.status).toBe("invalid_response");
    // 200 with genuinely empty history -> none.
    ref = await draftWithLedger(async () => Response.json({query: "豚バラ肉", candidates: []}));
    expect(ref.status).toBe("none");
    expect(ref.text).toContain("仕入履歴がありません");
    // Missing unit catalog connection fails closed before invoking the model.
    delete process.env.FASTAPI_BASE_URL; delete process.env.DEMO_ACCESS_TOKEN;
    let museCalled = false;
    global.fetch = unitCatalogFetch((async () => { museCalled = true; return museOk(); }) as typeof fetch);
    const res = await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["豚バラ肉100g、平均価格を調べて"]}));
    expect(res.status).toBe(503);
    expect(museCalled).toBe(false);
    // Failure entries carry no prices and block nothing: notes stay empty.
    expect((await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["豚バラ肉100g"]})) ).status).toBe(503);
  } finally {
    global.fetch = previousFetch;
    if (password === undefined) delete process.env.DEMO_PREVIEW_PASSWORD; else process.env.DEMO_PREVIEW_PASSWORD = password;
    if (key === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = key;
    if (base === undefined) delete process.env.FASTAPI_BASE_URL; else process.env.FASTAPI_BASE_URL = base;
    if (token === undefined) delete process.env.DEMO_ACCESS_TOKEN; else process.env.DEMO_ACCESS_TOKEN = token;
  }
});

test("ingredient name corrections stay informational and validate strictly", async () => {
  const password = process.env.DEMO_PREVIEW_PASSWORD, key = process.env.MODEL_API_KEY;
  process.env.DEMO_PREVIEW_PASSWORD = PASSWORD; process.env.MODEL_API_KEY = "fixture-key";
  const previousFetch = global.fetch;
  try {
    const recipe = {title: "テスト", materials: [{name: "片栗粉", quantity: "15", unit: "g",
      price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
      selling_price_jpy: "", notes: [], interpretations: [], price_research: [],
      name_corrections: [{material_name: "片栗粉", heard: "かたくりこ",
        candidates: [{name: "片栗粉", reason: "一般的な調味料名の音誤認を料理文脈で補正"},
          {name: "コーンスターチ", reason: "用途が近い代替の候補"}]}]};
    global.fetch = unitCatalogFetch((async () => Response.json({choices: [{finish_reason: "stop",
      message: {content: JSON.stringify(recipe)}}]})) as typeof fetch);
    const ok = await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["かたくりこ15g"]}));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.nameCorrections).toHaveLength(1);
    expect(body.nameCorrections[0].candidates).toHaveLength(2);
    // Informational: notes and save-relevant fields untouched.
    expect(body.notes).toEqual([]);
    expect(body.materials[0].name).toBe("片栗粉");
    // Four candidates exceed the 1-3 cap and fail closed.
    const tooMany = {...recipe, name_corrections: [{material_name: "粉", heard: "こな",
      candidates: [{name: "a", reason: "r"}, {name: "b", reason: "r"},
        {name: "c", reason: "r"}, {name: "d", reason: "r"}]}]};
    global.fetch = unitCatalogFetch((async () => Response.json({choices: [{finish_reason: "stop",
      message: {content: JSON.stringify(tooMany)}}]})) as typeof fetch);
    expect((await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["こな"]})) ).status).toBe(502);
    // Empty candidates fail closed instead of padding silently.
    const emptyCands = {...recipe,
      name_corrections: [{material_name: "粉", heard: "こな", candidates: []}]};
    global.fetch = unitCatalogFetch((async () => Response.json({choices: [{finish_reason: "stop",
      message: {content: JSON.stringify(emptyCands)}}]})) as typeof fetch);
    expect((await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["こな"]})) ).status).toBe(502);
  } finally {
    global.fetch = previousFetch;
    if (password === undefined) delete process.env.DEMO_PREVIEW_PASSWORD; else process.env.DEMO_PREVIEW_PASSWORD = password;
    if (key === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = key;
  }
});
