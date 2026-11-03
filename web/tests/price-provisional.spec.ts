import {test, expect} from "@playwright/test";
import {NextRequest} from "next/server";
import {POST as parseRecipe} from "../app/api/voice-recipe/route";
import {runGroundedSearch} from "../price-web-search";
import {detectPriceResearch} from "../price-research-intent";


const UNIT_FIXTURE={items:[{id:"00000000-0000-4000-8000-000000000001",symbol:"g",dimension:"mass",base_factor:"1",aliases:[]}]};
function withUnitCatalog(mock:typeof fetch):typeof fetch{
 return (async (input:RequestInfo|URL,init?:RequestInit)=>{
  if(String(input).includes("/demo/units"))return Response.json(UNIT_FIXTURE);
  return mock(input,init);
 }) as typeof fetch;
}
const PASSWORD = "test-only-preview-password-32-characters";
function authed(url: string, body: unknown) {
  return new NextRequest(url, {method: "POST",
    headers: {Origin: "http://localhost",
      Authorization: "Basic " + Buffer.from("chef:" + PASSWORD).toString("base64")},
    body: JSON.stringify(body)});
}
const CANDIDATE = {name: "pasta", amount: "380", currency: "JPY",
  package_quantity: "500", package_unit: "g",
  seller: "Shop A", source: "shop.example", url: "https://shop.example/pasta"};
const CITATION = {url: "https://shop.example/pasta", title: "Shop A"};
function grounded(candidates: unknown, citations = [CITATION]) {
  return {status: "completed", output: [
    {type: "web_search_call", status: "completed"},
    {type: "message", role: "assistant", status: "completed", content: [
      {type: "output_text", text: JSON.stringify({candidates}),
        annotations: citations.map(c => ({type: "url_citation", ...c}))}]}]};
}
const MUSE_RECIPE = (research: unknown) => ({title: "pasta",
  materials: [{name: "pasta", quantity: "100", unit: "g",
    price_jpy: "", price_quantity: "", price_unit: "", supplier: "De Cecco"}],
  selling_price_jpy: "", notes: [], interpretations: [], price_research: research});

test("heuristic fires on explicit requests, never on stated prices", () => {
  const empty = [{name: "pasta", price_jpy: "", price_quantity: "", price_unit: ""}];
  for (const turn of ["pasta100g\u3001平均仕入価格を調べて",
    "この食材の価格を調べておいて", "Find a reference price for this ingredient.",
    "use the average price for the pasta"]) {
    const out = detectPriceResearch([turn], empty);
    expect(out.length).toBe(1);
    expect(out[0].material_name).toBe("pasta");
  }
  // Stated prices and vague cheapness are not research requests.
  for (const turn of ["pasta100g、500g380円", "安いね", "pasta100g"]) {
    expect(detectPriceResearch([turn], empty)).toEqual([]);
  }
  // Already priced lines are never re-searched.
  const priced = [{name: "pasta", price_jpy: "380", price_quantity: "500", price_unit: "g"}];
  expect(detectPriceResearch(["相場で入れて"], priced)).toEqual([]);
});

test("heuristic scopes to the named ingredient; wide requests cover all", () => {
  const four = ["flour", "water", "salt", "saffron"].map(name =>
    ({name, price_jpy: "", price_quantity: "", price_unit: ""}));
  // A named request targets only that ingredient, so the route cap cannot
  // eject it in favor of unrelated lines.
  expect(detectPriceResearch(["check the price of saffron"], four).map(o => o.material_name))
    .toEqual(["saffron"]);
  const fourJa = ["小麦粉", "水", "塩", "サフラン"].map(name =>
    ({name, price_jpy: "", price_quantity: "", price_unit: ""}));
  expect(detectPriceResearch(["サフランの価格を調べて"], fourJa).map(o => o.material_name))
    .toEqual(["サフラン"]);
  // Explicit recipe-wide requests target every open line.
  for (const turn of ["全食材の平均価格を調べて", "use the average price for all ingredients"]) {
    expect(detectPriceResearch([turn], four).map(o => o.material_name))
      .toEqual(["flour", "water", "salt", "saffron"]);
  }
  // Deictic with several open lines and no names: guess nothing.
  expect(detectPriceResearch(["この食材の価格を調べておいて"], four)).toEqual([]);
  expect(detectPriceResearch(["Find a reference price for this ingredient."], four)).toEqual([]);
});

test("grounded outcomes distinguish searched, empty, failure, and timeout", async () => {
  const ok = (body: unknown) => ({fetchImpl: (async () => Response.json(body)) as typeof fetch});
  expect((await runGroundedSearch({apiKey: "k", materialName: "pasta", request: "r", ...ok(grounded([CANDIDATE]))})).kind).toBe("found");
  expect((await runGroundedSearch({apiKey: "k", materialName: "pasta", request: "r", ...ok(grounded([]))})).kind).toBe("empty");
  expect((await runGroundedSearch({apiKey: "k", materialName: "pasta", request: "r",
    ...ok({status: "completed", output: []})})).kind).toBe("not_searched");
  expect((await runGroundedSearch({apiKey: "k", materialName: "pasta", request: "r",
    fetchImpl: (async () => new Response("e", {status: 500})) as typeof fetch})).kind).toBe("provider_error");
  const abort = Object.assign(new Error("x"), {name: "AbortError"});
  expect((await runGroundedSearch({apiKey: "k", materialName: "pasta", request: "r",
    fetchImpl: (async () => { throw abort; }) as typeof fetch})).kind).toBe("timeout");
  expect((await runGroundedSearch({apiKey: "", materialName: "pasta", request: "r"})).kind).toBe("misconfigured");
});

test("grounding request puts search_context_size inside the web_search tool", async () => {
  let body: Record<string, unknown> = {};
  const fetchImpl = (async (_url: unknown, init?: {body?: unknown}) => {
    body = JSON.parse(String((init as {body?: string}).body));
    return Response.json(grounded([CANDIDATE]));
  }) as typeof fetch;
  expect((await runGroundedSearch({apiKey: "k", materialName: "pasta", request: "r", fetchImpl})).kind).toBe("found");
  const tools = body.tools as {type: string; search_context_size?: string}[];
  expect(tools).toEqual([{type: "web_search", search_context_size: "low"}]);
  expect("search_context_size" in body).toBe(false);
});

test("tool-run candidates with their own source URLs count as searched", async () => {
  const bare = {status: "completed", output: [
    {type: "web_search_call", status: "completed"},
    {type: "message", role: "assistant", status: "completed", content: [
      {type: "output_text", text: JSON.stringify({candidates: [CANDIDATE]}), annotations: []}]}]};
  const ok = (b: unknown) => ({fetchImpl: (async () => Response.json(b)) as typeof fetch});
  const out = await runGroundedSearch({apiKey: "k", materialName: "pasta", request: "r", ...ok(bare)});
  expect(out.kind).toBe("found");
  if (out.kind === "found") {
    expect(out.entry.sources.map(s => s.url)).toContain(CANDIDATE.url);
  }
  // Tool call without citations AND without candidate URLs stays not_searched.
  const prose = {status: "completed", output: [
    {type: "web_search_call", status: "completed"},
    {type: "message", role: "assistant", status: "completed", content: [
      {type: "output_text", text: "no prices found", annotations: []}]}]};
  expect((await runGroundedSearch({apiKey: "k", materialName: "pasta", request: "r", ...ok(prose)})).kind).toBe("not_searched");
});

test("fallback never averages an unsourced price on another row's URL", async () => {
  const bare = (candidates: unknown) => ({status: "completed", output: [
    {type: "web_search_call", status: "completed"},
    {type: "message", role: "assistant", status: "completed", content: [
      {type: "output_text", text: JSON.stringify({candidates}), annotations: []}]}]});
  const ok = (b: unknown) => ({fetchImpl: (async () => Response.json(b)) as typeof fetch});
  const unsourced = {...CANDIDATE};
  delete (unsourced as {url?: string}).url;
  // Unsourced price row + invalid row carrying a URL: no usable price, so
  // the invalid row's URL must not authorize a "found".
  const mixed = await runGroundedSearch({apiKey: "k", materialName: "pasta", request: "r",
    ...ok(bare([unsourced, {url: "https://example.com/no-price"}]))});
  expect(mixed.kind).toBe("empty");
  // Sourced and unsourced rows together: only the sourced row counts.
  const cheap = {...CANDIDATE};
  delete (cheap as {url?: string}).url;
  cheap.amount = "100";
  const both = await runGroundedSearch({apiKey: "k", materialName: "pasta", request: "r",
    ...ok(bare([CANDIDATE, cheap]))});
  expect(both.kind).toBe("found");
  if (both.kind === "found") {
    expect(both.entry.average_unit_price).toBe("0.7600");
    expect(both.entry.observation_count).toBe(1);
    expect(both.entry.samples.map(x => x.amount)).toEqual(["380"]);
  }
  // A non-URL string is not source evidence.
  const bogus = await runGroundedSearch({apiKey: "k", materialName: "pasta", request: "r",
    ...ok(bare([{...CANDIDATE, url: "not a url"}]))});
  expect(bogus.kind).toBe("not_searched");
});

test("omitted price_research still reaches grounding; provisional stays unapproved", async () => {
  const password = process.env.DEMO_PREVIEW_PASSWORD, key = process.env.MODEL_API_KEY;
  const base = process.env.FASTAPI_BASE_URL, token = process.env.DEMO_ACCESS_TOKEN;
  process.env.FASTAPI_BASE_URL = "http://127.0.0.1:8100"; process.env.DEMO_ACCESS_TOKEN = "fixture-demo-token";
  process.env.DEMO_PREVIEW_PASSWORD = PASSWORD; process.env.MODEL_API_KEY = "fixture-key";
  const previousFetch = global.fetch;
  try {
    // Muse omits price_research; the ledger is unreachable (no binding/token).
    global.fetch = withUnitCatalog((async (url: unknown) => {
      if (String(url).includes("/v1/responses")) return Response.json(grounded([CANDIDATE]));
      return Response.json({choices: [{finish_reason: "stop", message: {content: JSON.stringify(MUSE_RECIPE([]))}}]});
    }) as typeof fetch);
    const res = await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["pasta100g、平均仕入価格を調べて"]}));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Grounding ran (heuristic trigger), materials untouched, provisional separate.
    expect(body.research_status).toEqual([{material_name: "pasta", material_index: 0,
      request: "pasta100g、平均仕入価格を調べて", trigger: "heuristic",
      ledger: "invalid_response", web: "available", provisional: true}]);
    expect(body.price_references[0].origin).toBe("external");
    expect(body.materials[0].price_jpy).toBe("");
    expect(body.missing).toContain("pastaの仕入単価・基準数量・単位");
    const prov = body.provisional_prices[0];
    expect(prov.status).toBe("provisional");
    expect(prov.approval).toBe("unapproved");
    expect(prov.origin).toBe("external");
    expect(prov.price_jpy).toBe("0.7600");
    expect(prov.price_quantity).toBe("1");
    expect(prov.price_unit).toBe("g");
    expect(prov.sources).toEqual([CITATION]);
    expect(prov.samples[0].url).toBe(CANDIDATE.url);
  } finally {
    global.fetch = previousFetch;
    if (password === undefined) delete process.env.DEMO_PREVIEW_PASSWORD; else process.env.DEMO_PREVIEW_PASSWORD = password;
    if (key === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = key;
    if (base === undefined) delete process.env.FASTAPI_BASE_URL; else process.env.FASTAPI_BASE_URL = base;
    if (token === undefined) delete process.env.DEMO_ACCESS_TOKEN; else process.env.DEMO_ACCESS_TOKEN = token;
  }
});

test("grounding failure keeps the draft and reports the stage", async () => {
  const password = process.env.DEMO_PREVIEW_PASSWORD, key = process.env.MODEL_API_KEY;
  const base = process.env.FASTAPI_BASE_URL, token = process.env.DEMO_ACCESS_TOKEN;
  process.env.FASTAPI_BASE_URL = "http://127.0.0.1:8100"; process.env.DEMO_ACCESS_TOKEN = "fixture-demo-token";
  process.env.DEMO_PREVIEW_PASSWORD = PASSWORD; process.env.MODEL_API_KEY = "fixture-key";
  const previousFetch = global.fetch;
  try {
    global.fetch = withUnitCatalog((async (url: unknown) => {
      if (String(url).includes("/v1/responses")) return new Response("e", {status: 500});
      return Response.json({choices: [{finish_reason: "stop", message: {content:
        JSON.stringify(MUSE_RECIPE([{material_name: "pasta", request: "r"}]))}}]});
    }) as typeof fetch);
    const res = await parseRecipe(authed("http://localhost/api/voice-recipe", {turns: ["pasta100g"]}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.research_status).toEqual([{material_name: "pasta", material_index: 0,
      request: "r", trigger: "muse",
      ledger: "invalid_response", web: "provider_error", provisional: false}]);
    expect(body.price_references[0].status).toBe("unavailable");
    expect(body.provisional_prices).toEqual([null]);
    expect(body.materials[0].price_jpy).toBe("");
  } finally {
    global.fetch = previousFetch;
    if (password === undefined) delete process.env.DEMO_PREVIEW_PASSWORD; else process.env.DEMO_PREVIEW_PASSWORD = password;
    if (key === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = key;
    if (base === undefined) delete process.env.FASTAPI_BASE_URL; else process.env.FASTAPI_BASE_URL = base;
    if (token === undefined) delete process.env.DEMO_ACCESS_TOKEN; else process.env.DEMO_ACCESS_TOKEN = token;
  }
});

test("no request means no search, no provisional, no status", async () => {
  const password = process.env.DEMO_PREVIEW_PASSWORD, key = process.env.MODEL_API_KEY;
  const base = process.env.FASTAPI_BASE_URL, token = process.env.DEMO_ACCESS_TOKEN;
  process.env.FASTAPI_BASE_URL = "http://127.0.0.1:8100"; process.env.DEMO_ACCESS_TOKEN = "fixture-demo-token";
  process.env.DEMO_PREVIEW_PASSWORD = PASSWORD; process.env.MODEL_API_KEY = "fixture-key";
  const previousFetch = global.fetch;
  try {
    let responsesCalls = 0;
    global.fetch = withUnitCatalog((async (url: unknown) => {
      if (String(url).includes("/v1/responses")) { responsesCalls++; }
      return Response.json({choices: [{finish_reason: "stop", message: {content: JSON.stringify(MUSE_RECIPE([]))}}]});
    }) as typeof fetch);
    const res = await parseRecipe(authed("http://localhost/api/voice-recipe", {turns: ["pasta100g"]}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(responsesCalls).toBe(0);
    expect(body.research_status).toEqual([]);
    expect(body.provisional_prices).toEqual([null]);
  } finally {
    global.fetch = previousFetch;
    if (password === undefined) delete process.env.DEMO_PREVIEW_PASSWORD; else process.env.DEMO_PREVIEW_PASSWORD = password;
    if (key === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = key;
    if (base === undefined) delete process.env.FASTAPI_BASE_URL; else process.env.FASTAPI_BASE_URL = base;
    if (token === undefined) delete process.env.DEMO_ACCESS_TOKEN; else process.env.DEMO_ACCESS_TOKEN = token;
  }
});

test("named heuristic request survives the entry cap; only saffron is searched", async () => {
  const password = process.env.DEMO_PREVIEW_PASSWORD, key = process.env.MODEL_API_KEY;
  const base = process.env.FASTAPI_BASE_URL, token = process.env.DEMO_ACCESS_TOKEN;
  process.env.FASTAPI_BASE_URL = "http://127.0.0.1:8100"; process.env.DEMO_ACCESS_TOKEN = "fixture-demo-token";
  process.env.DEMO_PREVIEW_PASSWORD = PASSWORD; process.env.MODEL_API_KEY = "fixture-key";
  const previousFetch = global.fetch;
  try {
    const names = ["flour", "water", "salt", "サフラン"];
    const muse = {title: "t",
      materials: names.map(name => ({name, quantity: "100", unit: "g",
        price_jpy: "", price_quantity: "", price_unit: "", supplier: ""})),
      selling_price_jpy: "", notes: [], interpretations: [], price_research: []};
    const saffron = {...CANDIDATE, name: "サフラン"};
    let groundingCalls = 0;
    global.fetch = withUnitCatalog((async (url: unknown) => {
      if (String(url).includes("/v1/responses")) {
        groundingCalls++;
        return Response.json(grounded([saffron]));
      }
      return Response.json({choices: [{finish_reason: "stop", message: {content: JSON.stringify(muse)}}]});
    }) as typeof fetch);
    const res = await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["サフランの平均仕入価格を調べて"]}));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Only the named ingredient is researched: one grounding call, and the
    // three-entry cap cannot eject saffron for unrelated lines.
    expect(groundingCalls).toBe(1);
    expect(body.research_status).toEqual([{material_name: "サフラン", material_index: 3,
      request: "サフランの平均仕入価格を調べて", trigger: "heuristic",
      ledger: "invalid_response", web: "available", provisional: true}]);
    expect(body.provisional_prices.map((x: {material_name: string} | null) => x?.material_name ?? null))
      .toEqual([null, null, null, "サフラン"]);
  } finally {
    global.fetch = previousFetch;
    if (password === undefined) delete process.env.DEMO_PREVIEW_PASSWORD; else process.env.DEMO_PREVIEW_PASSWORD = password;
    if (key === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = key;
    if (base === undefined) delete process.env.FASTAPI_BASE_URL; else process.env.FASTAPI_BASE_URL = base;
    if (token === undefined) delete process.env.DEMO_ACCESS_TOKEN; else process.env.DEMO_ACCESS_TOKEN = token;
  }
});

test("http internal binding host reaches the ledger (PR #89 contract kept)", async () => {
  const password = process.env.DEMO_PREVIEW_PASSWORD, key = process.env.MODEL_API_KEY;
  const internal = process.env.CHEF_FASTAPI_INTERNAL_URL, base = process.env.FASTAPI_BASE_URL;
  const token = process.env.DEMO_ACCESS_TOKEN;
  delete process.env.FASTAPI_BASE_URL;
  // Vercel/Render internal binding: http-only by platform design, must not be rejected.
  process.env.CHEF_FASTAPI_INTERNAL_URL = "http://chef-ai-workspace-api:10000";
  process.env.DEMO_ACCESS_TOKEN = "fixture-demo-token";
  process.env.DEMO_PREVIEW_PASSWORD = PASSWORD; process.env.MODEL_API_KEY = "fixture-key";
  const previousFetch = global.fetch;
  try {
    let responsesCalls = 0;
    global.fetch = withUnitCatalog((async (url: unknown) => {
      if (String(url).includes("/v1/responses")) {
        responsesCalls++;
        return Response.json(grounded([CANDIDATE]));
      }
      if (String(url).includes("/demo/price-reference")) {
        return Response.json({query: "pasta", candidates: [{ingredient_id: "ing-1",
          ingredient_name: "pasta",
          reference: {available: true, currency: "JPY", unit_basis: "g",
            average_unit_price: "0.7600", observation_count: 3,
            observed_to: "2026-10-01T00:00:00.000Z"}}]});
      }
      return Response.json({choices: [{finish_reason: "stop", message: {content:
        JSON.stringify(MUSE_RECIPE([{material_name: "pasta", request: "r"}]))}}]});
    }) as typeof fetch);
    const res = await parseRecipe(authed("http://localhost/api/voice-recipe", {turns: ["pasta100g"]}));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Ledger wins over http internal binding: no web search, ledger provisional.
    expect(responsesCalls).toBe(0);
    expect(body.price_references[0].origin).toBe("ledger");
    expect(body.research_status).toEqual([{material_name: "pasta", material_index: 0,
      request: "r", trigger: "muse",
      ledger: "available", web: "not_attempted", provisional: true}]);
    expect(body.provisional_prices[0].origin).toBe("ledger");
    expect(body.provisional_prices[0].approval).toBe("unapproved");
  } finally {
    global.fetch = previousFetch;
    if (password === undefined) delete process.env.DEMO_PREVIEW_PASSWORD; else process.env.DEMO_PREVIEW_PASSWORD = password;
    if (key === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = key;
    if (internal === undefined) delete process.env.CHEF_FASTAPI_INTERNAL_URL; else process.env.CHEF_FASTAPI_INTERNAL_URL = internal;
    if (base === undefined) delete process.env.FASTAPI_BASE_URL; else process.env.FASTAPI_BASE_URL = base;
    if (token === undefined) delete process.env.DEMO_ACCESS_TOKEN; else process.env.DEMO_ACCESS_TOKEN = token;
  }
});

test("drifted Muse name with material_index still binds the right row", async () => {
  const password = process.env.DEMO_PREVIEW_PASSWORD, key = process.env.MODEL_API_KEY;
  const base = process.env.FASTAPI_BASE_URL, token = process.env.DEMO_ACCESS_TOKEN;
  process.env.FASTAPI_BASE_URL = "http://127.0.0.1:8100"; process.env.DEMO_ACCESS_TOKEN = "fixture-demo-token";
  process.env.DEMO_PREVIEW_PASSWORD = PASSWORD; process.env.MODEL_API_KEY = "fixture-key";
  const previousFetch = global.fetch;
  try {
    // Row 0 is "ディチェコ パスタ" but Muse's research entry says "パスタ".
    // material_index 0 is the canonical key: the provisional binds row 0
    // under the ROW name, while the searched name stays in references.
    const muse = {title: "t",
      materials: [
        {name: "ディチェコ パスタ", quantity: "100", unit: "g",
          price_jpy: "", price_quantity: "", price_unit: "", supplier: "De Cecco"},
        {name: "ホールトマト", quantity: "200", unit: "g",
          price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
      selling_price_jpy: "", notes: [], interpretations: [],
      price_research: [{material_name: "パスタ", material_index: 0, request: "平均価格を調べて"}]};
    global.fetch = withUnitCatalog((async (url: unknown) => {
      if (String(url).includes("/v1/responses")) return Response.json(grounded([CANDIDATE]));
      return Response.json({choices: [{finish_reason: "stop", message: {content: JSON.stringify(muse)}}]});
    }) as typeof fetch);
    const res = await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["ディチェコのパスタ100g、平均価格を調べて"]}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.research_status).toEqual([{material_name: "パスタ", material_index: 0,
      request: "平均価格を調べて", trigger: "muse",
      ledger: "invalid_response", web: "available", provisional: true}]);
    expect(body.price_references[0].material_name).toBe("パスタ");
    expect(body.price_references[0].material_index).toBe(0);
    const prov = body.provisional_prices[0];
    expect(prov.material_index).toBe(0);
    expect(prov.material_name).toBe("ディチェコ パスタ");
    expect(prov.price_jpy).toBe("0.7600");
    expect(body.provisional_prices[1]).toBeNull();
    // The draft row itself is untouched: names and prices never rewritten.
    expect(body.materials[0].name).toBe("ディチェコ パスタ");
    expect(body.materials[0].price_jpy).toBe("");
  } finally {
    global.fetch = previousFetch;
    if (password === undefined) delete process.env.DEMO_PREVIEW_PASSWORD; else process.env.DEMO_PREVIEW_PASSWORD = password;
    if (key === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = key;
    if (base === undefined) delete process.env.FASTAPI_BASE_URL; else process.env.FASTAPI_BASE_URL = base;
    if (token === undefined) delete process.env.DEMO_ACCESS_TOKEN; else process.env.DEMO_ACCESS_TOKEN = token;
  }
});

test("contradictory index loses to an exact row-name match", async () => {
  const password = process.env.DEMO_PREVIEW_PASSWORD, key = process.env.MODEL_API_KEY;
  const base = process.env.FASTAPI_BASE_URL, token = process.env.DEMO_ACCESS_TOKEN;
  process.env.FASTAPI_BASE_URL = "http://127.0.0.1:8100"; process.env.DEMO_ACCESS_TOKEN = "fixture-demo-token";
  process.env.DEMO_PREVIEW_PASSWORD = PASSWORD; process.env.MODEL_API_KEY = "fixture-key";
  const previousFetch = global.fetch;
  try {
    // Row 0 is pasta, row 1 is tomato; the entry names tomato exactly but
    // carries material_index 0. Trusting the pointer would misbind pasta.
    const muse = {title: "t",
      materials: [
        {name: "pasta", quantity: "100", unit: "g",
          price_jpy: "", price_quantity: "", price_unit: "", supplier: ""},
        {name: "tomato", quantity: "200", unit: "g",
          price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
      selling_price_jpy: "", notes: [], interpretations: [],
      price_research: [{material_name: "tomato", material_index: 0, request: "r"}]};
    global.fetch = withUnitCatalog((async (url: unknown) => {
      if (String(url).includes("/v1/responses")) return Response.json(grounded([CANDIDATE]));
      return Response.json({choices: [{finish_reason: "stop", message: {content: JSON.stringify(muse)}}]});
    }) as typeof fetch);
    const res = await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["tomato"]}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.research_status[0].material_index).toBe(1);
    expect(body.provisional_prices[0]).toBeNull();
    expect(body.provisional_prices[1].material_name).toBe("tomato");
  } finally {
    global.fetch = previousFetch;
    if (password === undefined) delete process.env.DEMO_PREVIEW_PASSWORD; else process.env.DEMO_PREVIEW_PASSWORD = password;
    if (key === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = key;
    if (base === undefined) delete process.env.FASTAPI_BASE_URL; else process.env.FASTAPI_BASE_URL = base;
    if (token === undefined) delete process.env.DEMO_ACCESS_TOKEN; else process.env.DEMO_ACCESS_TOKEN = token;
  }
});

test("bad index falls back to the row name; unknown names stay rowless", async () => {
  const password = process.env.DEMO_PREVIEW_PASSWORD, key = process.env.MODEL_API_KEY;
  const base = process.env.FASTAPI_BASE_URL, token = process.env.DEMO_ACCESS_TOKEN;
  process.env.FASTAPI_BASE_URL = "http://127.0.0.1:8100"; process.env.DEMO_ACCESS_TOKEN = "fixture-demo-token";
  process.env.DEMO_PREVIEW_PASSWORD = PASSWORD; process.env.MODEL_API_KEY = "fixture-key";
  const previousFetch = global.fetch;
  async function runWith(research: unknown) {
    const muse = {...MUSE_RECIPE(research)};
    global.fetch = withUnitCatalog((async (url: unknown) => {
      if (String(url).includes("/v1/responses")) return Response.json(grounded([CANDIDATE]));
      return Response.json({choices: [{finish_reason: "stop", message: {content: JSON.stringify(muse)}}]});
    }) as typeof fetch);
    const res = await parseRecipe(authed("http://localhost/api/voice-recipe", {turns: ["pasta100g"]}));
    expect(res.status).toBe(200);
    return res.json();
  }
  try {
    // Out-of-range index with an exact row name: the name still binds row 0.
    const ranged = await runWith([{material_name: "pasta", material_index: 9, request: "r"}]);
    expect(ranged.research_status[0].material_index).toBe(0);
    expect(ranged.provisional_prices[0].material_name).toBe("pasta");
    // Unknown name with a bad index: searched by name, but rowless, so no
    // provisional can attach to a row it might miss.
    const rowless = await runWith([{material_name: "quinoa", material_index: 5, request: "r"}]);
    expect(rowless.research_status[0].material_index).toBe(-1);
    expect(rowless.price_references[0].material_name).toBe("quinoa");
    expect(rowless.provisional_prices).toEqual([null]);
  } finally {
    global.fetch = previousFetch;
    if (password === undefined) delete process.env.DEMO_PREVIEW_PASSWORD; else process.env.DEMO_PREVIEW_PASSWORD = password;
    if (key === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = key;
    if (base === undefined) delete process.env.FASTAPI_BASE_URL; else process.env.FASTAPI_BASE_URL = base;
    if (token === undefined) delete process.env.DEMO_ACCESS_TOKEN; else process.env.DEMO_ACCESS_TOKEN = token;
  }
});

test("applying a shown price is not a new search", () => {
  const open = [{name: "pasta", price_jpy: "", price_quantity: "", price_unit: ""}];
  const four = ["flour", "water", "salt", "saffron"].map(name =>
    ({name, price_jpy: "", price_quantity: "", price_unit: ""}));
  // 「その価格を使って」 answers a previous candidate: no research entry.
  expect(detectPriceResearch(["その価格を使って"], open)).toEqual([]);
  expect(detectPriceResearch(["その価格を使って"], four)).toEqual([]);
  // Cheapest-supplier wording IS research, scoped to the named row.
  expect(detectPriceResearch(["pastaの一番安い仕入先を探して"], open).map(o => o.material_name))
    .toEqual(["pasta"]);
});
