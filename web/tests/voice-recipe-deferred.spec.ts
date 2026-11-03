import {test, expect} from "@playwright/test";
import {NextRequest} from "next/server";
import {POST as parseRecipe} from "../app/api/voice-recipe/route";
import {POST as fetchPrices} from "../app/api/voice-recipe/prices/route";


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
const CITATION = {url: "https://shop.example/pasta", title: "Shop A"};
const CANDIDATE = {name: "pasta", amount: "380", currency: "JPY",
  package_quantity: "500", package_unit: "g",
  seller: "Shop A", source: "shop.example", url: CITATION.url};
function grounded(candidates: unknown) {
  return {status: "completed", output: [
    {type: "web_search_call", status: "completed"},
    {type: "message", role: "assistant", status: "completed", content: [
      {type: "output_text", text: JSON.stringify({candidates}),
        annotations: [{type: "url_citation", ...CITATION}]}]}]};
}
const ledgerHit = (name: string) => ({query: name, candidates: [{ingredient_id: "1",
  ingredient_name: name, reference: {available: true, currency: "JPY",
  unit_basis: "g", average_unit_price: "0.9000", observation_count: 4, observed_to: "2026-10-01"}}]});
const MUSE_RECIPE = (research: unknown) => ({title: "pasta",
  materials: [
    {name: "pasta", quantity: "100", unit: "g", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""},
    {name: "tomato", quantity: "200", unit: "g", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
  selling_price_jpy: "", notes: [], interpretations: [], price_research: research,
  name_corrections: []});
function withEnv() {
  const saved = {password: process.env.DEMO_PREVIEW_PASSWORD, key: process.env.MODEL_API_KEY,
    base: process.env.FASTAPI_BASE_URL, token: process.env.DEMO_ACCESS_TOKEN};
  process.env.DEMO_PREVIEW_PASSWORD = PASSWORD; process.env.MODEL_API_KEY = "fixture-key";
  process.env.FASTAPI_BASE_URL = "http://localhost:9"; process.env.DEMO_ACCESS_TOKEN = "fixture-token";
  return () => {
    const s = saved;
    if (s.password === undefined) delete process.env.DEMO_PREVIEW_PASSWORD; else process.env.DEMO_PREVIEW_PASSWORD = s.password;
    if (s.key === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = s.key;
    if (s.base === undefined) delete process.env.FASTAPI_BASE_URL; else process.env.FASTAPI_BASE_URL = s.base;
    if (s.token === undefined) delete process.env.DEMO_ACCESS_TOKEN; else process.env.DEMO_ACCESS_TOKEN = s.token;
  };
}

test("defer_prices returns the draft without ledger or grounding calls", async () => {
  const restore = withEnv();
  const previousFetch = global.fetch;
  const calls: string[] = [];
  try {
    global.fetch = withUnitCatalog((async (url: unknown) => {
      calls.push(String(url));
      return Response.json({choices: [{finish_reason: "stop",
        message: {content: JSON.stringify(MUSE_RECIPE([{material_name: "pasta", request: "相場", material_index: 0}]))}}]});
    }) as typeof fetch);
    const res = await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["pasta100g、相場で"], defer_prices: true}));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Draft is complete; research is pending, never silently dropped.
    expect(body.title).toBe("pasta");
    expect(body.materials.length).toBe(2);
    expect(body.research_state).toBe("deferred");
    expect(body.pending_research).toEqual([{material_name: "pasta", material_index: 0,
      row_name: "pasta", request: "相場", trigger: "muse"}]);
    expect(body.price_references).toEqual([]);
    expect(body.research_status).toEqual([]);
    expect(body.provisional_prices).toEqual([null, null]);
    // Only the Muse call ran: no ledger, no grounding.
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("/v1/chat/completions");
  } finally {
    global.fetch = previousFetch; restore();
  }
});

test("default path still enriches inline and reports complete", async () => {
  const restore = withEnv();
  const previousFetch = global.fetch;
  try {
    global.fetch = withUnitCatalog((async (url: unknown) => {
      if (String(url).includes("/demo/price-reference"))
        return Response.json(ledgerHit("pasta"));
      return Response.json({choices: [{finish_reason: "stop",
        message: {content: JSON.stringify(MUSE_RECIPE([{material_name: "pasta", request: "相場", material_index: 0}]))}}]});
    }) as typeof fetch);
    const res = await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["pasta100g、相場で"]}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.research_state).toBe("complete");
    expect(body.pending_research).toBeUndefined();
    expect(body.price_references[0].status).toBe("available");
    expect(body.provisional_prices[0].price_jpy).toBe("0.9000");
  } finally {
    global.fetch = previousFetch; restore();
  }
});

test("concurrent entries keep entry order under out-of-order latency", async () => {
  const restore = withEnv();
  const previousFetch = global.fetch;
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  try {
    global.fetch = withUnitCatalog((async (url: unknown) => {
      const u = String(url);
      if (u.includes("/demo/price-reference")) {
        // First entry is slowest: sequential code would still be ordered,
        // but this pins that parallel completion never reorders rows.
        const name = new URL(u).searchParams.get("name");
        await sleep(name === "pasta" ? 120 : 10);
        return Response.json(ledgerHit(name ?? "?"));
      }
      return Response.json({choices: [{finish_reason: "stop",
        message: {content: JSON.stringify(MUSE_RECIPE([
          {material_name: "pasta", request: "r1", material_index: 0},
          {material_name: "tomato", request: "r2", material_index: 1}]))}}]});
    }) as typeof fetch);
    const started = performance.now();
    const res = await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["pastaとtomatoの相場"]}));
    const elapsed = performance.now() - started;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.research_status.map((s: {material_name: string}) => s.material_name))
      .toEqual(["pasta", "tomato"]);
    expect(body.provisional_prices[0].material_name).toBe("pasta");
    expect(body.provisional_prices[1].material_name).toBe("tomato");
    // Parallel: ~120ms, not ~130ms+ sequential sum. Generous bound only.
    expect(elapsed).toBeLessThan(1000);
  } finally {
    global.fetch = previousFetch; restore();
  }
});

test("deferred draft returns before slow enrichment would finish", async () => {
  const restore = withEnv();
  const previousFetch = global.fetch;
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const muse = () => Response.json({choices: [{finish_reason: "stop",
    message: {content: JSON.stringify(MUSE_RECIPE([{material_name: "pasta", request: "相場", material_index: 0}]))}}]});
  try {
    // Slow ledger + slow grounding: full path must wait, deferred must not.
    global.fetch = withUnitCatalog((async (url: unknown) => {
      const u = String(url);
      if (u.includes("/demo/price-reference")) { await sleep(400); return Response.json({query: "pasta", candidates: []}); }
      if (u.includes("/v1/responses")) { await sleep(400); return Response.json(grounded([CANDIDATE])); }
      return muse();
    }) as typeof fetch);
    const t0 = performance.now();
    const full = await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["pasta100g、相場で"]}));
    const fullMs = performance.now() - t0;
    expect(full.status).toBe(200);
    const t1 = performance.now();
    const deferred = await parseRecipe(authed("http://localhost/api/voice-recipe",
      {turns: ["pasta100g、相場で"], defer_prices: true}));
    const deferredMs = performance.now() - t1;
    expect(deferred.status).toBe(200);
    console.log(`deferred=${Math.round(deferredMs)}ms full=${Math.round(fullMs)}ms`);
    expect(deferredMs).toBeLessThan(fullMs);
    expect(fullMs).toBeGreaterThanOrEqual(400);
  } finally {
    global.fetch = previousFetch; restore();
  }
});

test("prices endpoint rebinds against the submitted snapshot", async () => {
  const restore = withEnv();
  const previousFetch = global.fetch;
  try {
    global.fetch = withUnitCatalog((async (url: unknown) => {
      if (String(url).includes("/demo/price-reference"))
        return Response.json(ledgerHit("tomato"));
      return Response.json(grounded([CANDIDATE]));
    }) as typeof fetch);
    // Contradictory index 0 with an exact row-1 name: the name wins, so the
    // price binds tomato (row 1), never pasta (row 0).
    const res = await fetchPrices(authed("http://localhost/api/voice-recipe/prices", {
      materials: [{name: "pasta"}, {name: "tomato"}],
      entries: [{material_name: "tomato", request: "相場", material_index: 0}]}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.research_state).toBe("complete");
    expect(body.research_status[0].material_index).toBe(1);
    expect(body.provisional_prices[0]).toBeNull();
    expect(body.provisional_prices[1].material_name).toBe("tomato");
    // Stale index (row deleted since defer): rowless, searched by name,
    // bound to nothing.
    const stale = await fetchPrices(authed("http://localhost/api/voice-recipe/prices", {
      materials: [{name: "pasta"}],
      entries: [{material_name: "ghost", request: "相場", material_index: 5}]}));
    expect(stale.status).toBe(200);
    const staleBody = await stale.json();
    expect(staleBody.research_status[0].material_index).toBe(-1);
    expect(staleBody.provisional_prices).toEqual([null]);
  } finally {
    global.fetch = previousFetch; restore();
  }
});

test("prices endpoint fails closed on bad shapes", async () => {
  const restore = withEnv();
  const previousFetch = global.fetch;
  try {
    global.fetch = withUnitCatalog((async () => Response.json({})) as typeof fetch);
    const bad = (body: unknown) => fetchPrices(authed("http://localhost/api/voice-recipe/prices", body));
    expect((await bad({materials: [], entries: "x"})).status).toBe(400);
    expect((await bad({materials: [{name: "pasta"}],
      entries: [{material_name: "", request: "r"}]})).status).toBe(400);
    expect((await bad({materials: [{name: "pasta"}],
      entries: [{material_name: "p", request: "r", material_index: -2}]})).status).toBe(400);
    expect((await bad({materials: [{name: "pasta"}],
      entries: [1, 2, 3, 4]})).status).toBe(400);
  } finally {
    global.fetch = previousFetch; restore();
  }
});

test("prices endpoint accepts rowless -1 without failing healthy entries", async () => {
  const restore = withEnv();
  const previousFetch = global.fetch;
  try {
    global.fetch = withUnitCatalog((async (url: unknown) => {
      if (String(url).includes("/demo/price-reference")) {
        const name = new URL(String(url)).searchParams.get("name") ?? "?";
        return Response.json(ledgerHit(name));
      }
      return Response.json(grounded([]));
    }) as typeof fetch);
    const res = await fetchPrices(authed("http://localhost/api/voice-recipe/prices", {
      materials: [{name: "pasta"}, {name: "tomato"}],
      entries: [
        {material_name: "ghost", request: "相場", material_index: -1},
        {material_name: "pasta", request: "相場", material_index: 0, row_name: "pasta"}]}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.research_status.map((e: {material_index: number}) => e.material_index))
      .toEqual([-1, 0]);
    expect(body.provisional_prices[0].material_name).toBe("pasta");
    expect(body.provisional_prices[1]).toBeNull();
  } finally {
    global.fetch = previousFetch; restore();
  }
});

test("deleted-row pointer never binds another ingredient", async () => {
  const restore = withEnv();
  const previousFetch = global.fetch;
  try {
    global.fetch = withUnitCatalog((async (url: unknown) => {
      if (String(url).includes("/demo/price-reference")) {
        const name = new URL(String(url)).searchParams.get("name") ?? "?";
        return Response.json(ledgerHit(name));
      }
      return Response.json(grounded([]));
    }) as typeof fetch);
    const call = (materials: unknown, entries: unknown) =>
      fetchPrices(authed("http://localhost/api/voice-recipe/prices", {materials, entries}));
    // [tomato, pasta] -> tomato deleted, [pasta]: index 0 now names pasta.
    // The tomato request carries its original row identity, so the stale
    // pointer is discarded: rowless, searched by name, bound to nothing.
    const deleted = await call([{name: "パスタ"}],
      [{material_name: "トマト", request: "相場", material_index: 0, row_name: "トマト"}]);
    expect(deleted.status).toBe(200);
    const deletedBody = await deleted.json();
    expect(deletedBody.research_status[0].material_index).toBe(-1);
    expect(deletedBody.provisional_prices).toEqual([null]);
    // Reorder [tomato, pasta] -> [pasta, tomato]: identity follows the name.
    const reordered = await call([{name: "パスタ"}, {name: "トマト"}],
      [{material_name: "トマト", request: "相場", material_index: 0, row_name: "トマト"}]);
    const reorderedBody = await reordered.json();
    expect(reorderedBody.research_status[0].material_index).toBe(1);
    expect(reorderedBody.provisional_prices[0]).toBeNull();
    expect(reorderedBody.provisional_prices[1].material_name).toBe("トマト");
    // Rename pasta -> spaghetti: the old pointer names nothing verifiable.
    const renamed = await call([{name: "スパゲッティ"}],
      [{material_name: "パスタ", request: "相場", material_index: 0, row_name: "パスタ"}]);
    const renamedBody = await renamed.json();
    expect(renamedBody.research_status[0].material_index).toBe(-1);
    expect(renamedBody.provisional_prices).toEqual([null]);
    // Confirmed drift: row still carries its creation name, so the index
    // names the row even though the searched wording differs.
    const drifted = await call([{name: "パスタ"}],
      [{material_name: "ディチェコ パスタ", request: "相場", material_index: 0, row_name: "パスタ"}]);
    const driftedBody = await drifted.json();
    expect(driftedBody.research_status[0].material_index).toBe(0);
    expect(driftedBody.provisional_prices[0].material_name).toBe("パスタ");
  } finally {
    global.fetch = previousFetch; restore();
  }
});

test("prices endpoint rejects bad row_name and out-of-shape indexes", async () => {
  const restore = withEnv();
  const previousFetch = global.fetch;
  try {
    global.fetch = withUnitCatalog((async () => Response.json({})) as typeof fetch);
    const bad = (body: unknown) => fetchPrices(authed("http://localhost/api/voice-recipe/prices", body));
    expect((await bad({materials: [{name: "pasta"}],
      entries: [{material_name: "p", request: "r", material_index: -2}]})).status).toBe(400);
    expect((await bad({materials: [{name: "pasta"}],
      entries: [{material_name: "p", request: "r", material_index: 1.5}]})).status).toBe(400);
    expect((await bad({materials: [{name: "pasta"}],
      entries: [{material_name: "p", request: "r", row_name: 123}]})).status).toBe(400);
  } finally {
    global.fetch = previousFetch; restore();
  }
});
