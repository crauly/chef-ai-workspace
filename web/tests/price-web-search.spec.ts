import {test, expect} from "@playwright/test";
import {NextRequest} from "next/server";
import {POST as parseRecipe} from "../app/api/voice-recipe/route";
import {
  buildPriceSearchInput,
  parseGroundedResponse,
  searchGroundedPrices,
  summarizeGroundedCandidates,
  validateGroundedCandidate,
} from "../price-web-search";

const PASSWORD = "test-only-preview-password-32-characters";
function authed(url: string, body: unknown) {
  return new NextRequest(url, {method: "POST",
    headers: {Origin: "http://localhost",
      Authorization: "Basic " + Buffer.from("chef:" + PASSWORD).toString("base64")},
    body: JSON.stringify(body)});
}
const RECIPE = (research: unknown) => ({title: "テスト",
  materials: [{name: "豚バラ肉", quantity: "100", unit: "g",
    price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
  selling_price_jpy: "", notes: [], interpretations: [], price_research: research});
const CANDIDATE = {name: "豚バラ肉", amount: "380", currency: "JPY",
  package_quantity: "500", package_unit: "g",
  seller: "Shop A", source: "shop.example", url: "https://shop.example/pork"};
const CITATION = {url: "https://shop.example/pork", title: "Shop A"};
function grounded(candidates: unknown, citations = [CITATION]) {
  return {status: "completed", output: [
    {type: "web_search_call", status: "completed"},
    {type: "message", role: "assistant", status: "completed", content: [
      {type: "output_text", text: JSON.stringify({candidates}),
        annotations: citations.map(c => ({type: "url_citation", ...c}))}]}]};
}

test("query carries the chef wording verbatim; validation never repairs", () => {
  expect(buildPriceSearchInput("豚バラ肉", "だいたいの相場で入れて")).toContain("だいたいの相場で入れて");
  expect(buildPriceSearchInput("pork", "use the average price", "en")).toContain("use the average price");
  expect(() => buildPriceSearchInput("  ", "x")).toThrow();
  expect(validateGroundedCandidate(CANDIDATE)).not.toBeNull();
  expect(validateGroundedCandidate({...CANDIDATE, amount: "abc"})).toBeNull();
  expect(validateGroundedCandidate({...CANDIDATE, package_unit: "cup"})).toBeNull();
  expect(validateGroundedCandidate({name: "x"})).toBeNull();
});

test("tool-call-only without citation is not a search; message-only is not a search", () => {
  expect(parseGroundedResponse(grounded([], [])).searched).toBe(false);
  const noCall = {status: "completed", output: [{type: "message", role: "assistant",
    status: "completed", content: [{type: "output_text", text: "{}",
      annotations: [{type: "url_citation", url: "https://s.example", title: "s"}]}]}]};
  expect(parseGroundedResponse(noCall).searched).toBe(false);
  const ok = parseGroundedResponse(grounded([CANDIDATE]));
  expect(ok.searched).toBe(true);
  expect(ok.citations).toEqual([CITATION]);
});

test("summary groups comparable offers and never claims a market average", () => {
  const usd = {...CANDIDATE, name: "pork", amount: "2.50", currency: "USD", seller: "B", source: "b.example"};
  const entry = summarizeGroundedCandidates([CANDIDATE, usd], [CITATION], "豚バラ肉", "2026-11-01T00:00:00Z");
  expect(entry.status).toBe("available");
  expect(entry.origin).toBe("external");
  expect(entry.currency).toBe("JPY");
  expect(entry.observation_count).toBe(1);
  expect(entry.text).toContain("サンプルからの参考値");
  expect(entry.text).not.toContain("市場平均");
  expect(entry.sources).toEqual([CITATION]);
  const empty = summarizeGroundedCandidates([{name: "x"}], [], "豚バラ肉");
  expect(empty.status).toBe("none");
});

test("real grounded shape (commentary, open_page, prose citations) parses", () => {
  const live = {status: "completed", output: [
    {type: "reasoning", status: "completed"},
    {type: "message", role: "assistant", status: "completed", phase: "commentary",
      content: [{type: "output_text", text: "候補を探します。", annotations: []}]},
    {type: "web_search_call", status: "completed", action: {type: "search", query: "豚バラ肉 500g"}},
    {type: "web_search_call", status: "completed", action: {type: "open_page", url: "https://a.example/p"}},
    {type: "message", role: "assistant", status: "completed", content: [{type: "output_text",
      text: '{"candidates": [{"name": "豚バラ肉", "amount": "920", "currency": "JPY", "package_quantity": "500", "package_unit": "g", "seller": "S", "source": "a.example", "url": "https://a.example/p"}]}\n- S: page https://a.example/p',
      annotations: [{type: "url_citation", title: "t", url: "https://a.example/p"}]}]},
  ]};
  const parsed = parseGroundedResponse(live);
  expect(parsed.searched).toBe(true);
  expect(parsed.citations).toHaveLength(1);
  const entry = summarizeGroundedCandidates(
    (parsed.modelJson as {candidates: unknown}).candidates as unknown[],
    parsed.citations, "豚バラ肉", "2026-11-01T00:00:00Z");
  expect(entry.status).toBe("available");
  expect(entry.average_unit_price).toBe("1.8400");
  expect(entry.text).toContain("サンプルからの参考値");
});

test("non-finite amounts are rejected in parity with Python is_finite", () => {
  for (const bad of ["NaN", "Infinity", "-Infinity"]) {
    expect(validateGroundedCandidate({...CANDIDATE, amount: bad})).toBeNull();
    expect(validateGroundedCandidate({...CANDIDATE, package_quantity: bad})).toBeNull();
  }
  // Poisoned rows drop out; the valid aggregate is unchanged: (380+460)/2/500.
  const good2 = {...CANDIDATE, name: "B", amount: "460", seller: "S2", source: "s2.example"};
  const entry = summarizeGroundedCandidates(
    [CANDIDATE, {...CANDIDATE, amount: "NaN"}, {...good2, amount: "Infinity"}, good2],
    [CITATION], "豚バラ肉", "2026-11-01T00:00:00Z");
  expect(entry.status).toBe("available");
  expect(entry.average_unit_price).toBe("0.8400");
  expect(entry.observation_count).toBe(2);
});

test("samples keep provenance; missing fields are never backfilled", () => {
  const mine = {...CANDIDATE, fetched_at: undefined,
    tax_note: "税込", shipping_note: "送料別"};
  const withTime = {...mine};
  (withTime as Record<string, unknown>).fetched_at = "2020-05-01T10:00:00Z";
  const entry = summarizeGroundedCandidates([withTime], [CITATION], "豚バラ肉", "2026-11-01T00:00:00Z");
  expect(entry.status).toBe("available");
  // Candidate-level observation time/URL/terms survive; the entry time differs.
  expect(entry.samples[0].fetched_at).toBe("2020-05-01T10:00:00Z");
  expect(entry.samples[0].url).toBe(CANDIDATE.url);
  expect(entry.samples[0].tax_note).toBe("税込");
  expect(entry.fetched_at).toBe("2026-11-01T00:00:00Z");
  const bare = summarizeGroundedCandidates([{...CANDIDATE}], [CITATION], "豚バラ肉", "2026-11-01T00:00:00Z");
  expect(bare.samples[0].url).toBe(CANDIDATE.url);
  expect(bare.samples[0].tax_note).toBeUndefined();
  expect(bare.samples[0].fetched_at).toBe("2026-11-01T00:00:00Z");
});

test("ledger hit never triggers web search; ledger miss falls back to grounding", async () => {
  const password = process.env.DEMO_PREVIEW_PASSWORD, key = process.env.MODEL_API_KEY;
  const base = process.env.FASTAPI_BASE_URL, token = process.env.DEMO_ACCESS_TOKEN;
  process.env.DEMO_PREVIEW_PASSWORD = PASSWORD; process.env.MODEL_API_KEY = "fixture-key";
  process.env.FASTAPI_BASE_URL = "http://127.0.0.1:8100"; process.env.DEMO_ACCESS_TOKEN = "fixture-demo-token";
  const previousFetch = global.fetch;
  try {
    const recipe = RECIPE([{material_name: "豚バラ肉", request: "だいたいの相場で入れて"}]);
    const ledger = {query: "豚バラ肉", candidates: [{ingredient_id: "ing-1",
      ingredient_name: "豚バラ肉", reference: {available: true, currency: "JPY",
        unit_basis: "g", average_unit_price: "0.7700", observation_count: 2,
        observed_to: "2026-10-28"}, observations: []}]};
    let responsesCalls = 0;
    global.fetch = (async (url: unknown) => {
      if (String(url).includes("/demo/price-reference")) return Response.json(ledger);
      if (String(url).includes("/v1/responses")) {
        responsesCalls++;
        return Response.json(grounded([CANDIDATE]));
      }
      return Response.json({choices: [{finish_reason: "stop", message: {content: JSON.stringify(recipe)}}]});
    }) as typeof fetch;
    const hit = await parseRecipe(authed("http://localhost/api/voice-recipe", {turns: ["豚バラ肉100g"]}));
    expect(hit.status).toBe(200);
    expect((await hit.json()).price_references[0].origin).toBe("ledger");
    expect(responsesCalls).toBe(0);
    // Ledger miss: empty candidates fall back to a real grounded search.
    global.fetch = (async (url: unknown) => {
      if (String(url).includes("/demo/price-reference")) return Response.json({query: "x", candidates: []});
      if (String(url).includes("/v1/responses")) {
        responsesCalls++;
        return Response.json(grounded([CANDIDATE]));
      }
      return Response.json({choices: [{finish_reason: "stop", message: {content: JSON.stringify(recipe)}}]});
    }) as typeof fetch;
    const miss = await parseRecipe(authed("http://localhost/api/voice-recipe", {turns: ["豚バラ肉100g"]}));
    expect(miss.status).toBe(200);
    const entry = (await miss.json()).price_references[0];
    expect(entry.origin).toBe("external");
    expect(entry.status).toBe("available");
    expect(entry.text).toContain("Web参考価格");
    expect(responsesCalls).toBe(1);
  } finally {
    global.fetch = previousFetch;
    if (password === undefined) delete process.env.DEMO_PREVIEW_PASSWORD; else process.env.DEMO_PREVIEW_PASSWORD = password;
    if (key === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = key;
    if (base === undefined) delete process.env.FASTAPI_BASE_URL; else process.env.FASTAPI_BASE_URL = base;
    if (token === undefined) delete process.env.DEMO_ACCESS_TOKEN; else process.env.DEMO_ACCESS_TOKEN = token;
  }
});

test("grounding failure keeps the ledger entry and never fails the draft", async () => {
  const password = process.env.DEMO_PREVIEW_PASSWORD, key = process.env.MODEL_API_KEY;
  const base = process.env.FASTAPI_BASE_URL, token = process.env.DEMO_ACCESS_TOKEN;
  process.env.DEMO_PREVIEW_PASSWORD = PASSWORD; process.env.MODEL_API_KEY = "fixture-key";
  process.env.FASTAPI_BASE_URL = "http://127.0.0.1:8100"; process.env.DEMO_ACCESS_TOKEN = "fixture-demo-token";
  const previousFetch = global.fetch;
  try {
    const recipe = RECIPE([{material_name: "豚バラ肉", request: "相場で入れて"}]);
    // Citation-free grounding result: not a search, ledger entry survives.
    global.fetch = (async (url: unknown) => {
      if (String(url).includes("/demo/price-reference")) return Response.json({query: "x", candidates: []});
      if (String(url).includes("/v1/responses")) return Response.json(grounded([], []));
      return Response.json({choices: [{finish_reason: "stop", message: {content: JSON.stringify(recipe)}}]});
    }) as typeof fetch;
    const res = await parseRecipe(authed("http://localhost/api/voice-recipe", {turns: ["豚バラ肉100g"]}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notes).toEqual([]);
    expect(body.price_references[0].origin).toBe("ledger");
    expect(body.price_references[0].status).toBe("none");
    expect(body.materials[0].price_jpy).toBe("");
    // searchGroundedPrices never throws on transport failure.
    const down = await searchGroundedPrices({apiKey: "k", materialName: "豚バラ肉", request: "相場",
      fetchImpl: (async () => { throw new Error("down"); }) as typeof fetch, timeoutMs: 1000});
    expect(down).toBeNull();
  } finally {
    global.fetch = previousFetch;
    if (password === undefined) delete process.env.DEMO_PREVIEW_PASSWORD; else process.env.DEMO_PREVIEW_PASSWORD = password;
    if (key === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = key;
    if (base === undefined) delete process.env.FASTAPI_BASE_URL; else process.env.FASTAPI_BASE_URL = base;
    if (token === undefined) delete process.env.DEMO_ACCESS_TOKEN; else process.env.DEMO_ACCESS_TOKEN = token;
  }
});
