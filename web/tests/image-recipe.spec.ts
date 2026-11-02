import {test, expect} from "@playwright/test";
import {NextRequest} from "next/server";
import {POST as proposeImage} from "../app/api/image-recipe/route";

const PASSWORD = "test-only-preview-password-32-characters";
function authed(url: string, body: unknown) {
  return new NextRequest(url, {method: "POST",
    headers: {Origin: "http://localhost",
      Authorization: "Basic " + Buffer.from("chef:" + PASSWORD).toString("base64")},
    body: JSON.stringify(body)});
}
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
// Image-only proposal: quantities/prices unknown -> empty strings, unresolved in notes.
const MUSE_IMAGE_PROPOSAL = {title: "トマトパスタ",
  materials: [
    {name: "ホールトマト", quantity: "", unit: "", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""},
    {name: "乾燥パスタ", quantity: "", unit: "", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
  selling_price_jpy: "", notes: ["数量・価格は写真から確定できない"], interpretations: [], price_research: [],
  name_corrections: []};
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
function mockUpstream(handler: (url: unknown, init: unknown) => unknown) {
  const previousFetch = global.fetch;
  global.fetch = handler as typeof fetch;
  return () => { global.fetch = previousFetch; };
}

test("image proposal reaches the draft contract with quantities unresolved", async () => {
  const restore = withEnv();
  let sentBody = "";
  const capture = mockUpstream(async (url: unknown, init: unknown) => {
    sentBody = String((init as {body?: unknown}).body ?? "");
    return Response.json({choices: [{finish_reason: "stop",
      message: {content: JSON.stringify(MUSE_IMAGE_PROPOSAL)}}]});
  });
  try {
    const res = await proposeImage(authed("http://localhost/api/image-recipe", {image: PNG}));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Same Draft contract as a deferred voice draft: approval flow + prices lifecycle attach unchanged.
    expect(body.research_state).toBe("deferred");
    expect(body.provisional_prices).toEqual([null, null]);
    expect(body.price_references).toEqual([]);
    expect(body.pending_research).toEqual([]);
    // Unknown quantities block approval via missing[], never silently saved.
    expect(body.missing).toContain("ホールトマトの数量・単位");
    expect(body.missing).toContain("ホールトマトの仕入単価・基準数量・単位");
    // The image actually reached the upstream payload beside structured output.
    const sent = JSON.parse(sentBody);
    const content = sent.messages[1].content;
    expect(content[1]).toEqual({type: "image_url", image_url: {url: PNG}});
    expect(sent.response_format.json_schema.name).toBe("chef_image_recipe");
  } finally { restore(); capture(); }
});

test("unsupported media type is rejected before any upstream call", async () => {
  const restore = withEnv();
  let called = false;
  const restoreFetch = mockUpstream(async () => { called = true; return Response.json({}); });
  try {
    const res = await proposeImage(authed("http://localhost/api/image-recipe",
      {image: "data:image/bmp;base64,AAAA"}));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("unsupported_media");
    expect(called).toBe(false);
  } finally { restore(); restoreFetch(); }
});

test("malformed image payload is rejected before any upstream call", async () => {
  const restore = withEnv();
  let called = false;
  const restoreFetch = mockUpstream(async () => { called = true; return Response.json({}); });
  try {
    const res = await proposeImage(authed("http://localhost/api/image-recipe", {image: "not-a-data-url"}));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_image");
    expect(called).toBe(false);
    const res2 = await proposeImage(authed("http://localhost/api/image-recipe", {}));
    expect(res2.status).toBe(400);
    expect((await res2.json()).code).toBe("invalid_image");
    expect(called).toBe(false);
  } finally { restore(); restoreFetch(); }
});

test("undecodable upstream 400 stays distinct from transport failures", async () => {
  const restore = withEnv();
  const restoreFetch = mockUpstream(async () => new Response("invalid image bytes", {status: 400}));
  try {
    const res = await proposeImage(authed("http://localhost/api/image-recipe", {image: PNG}));
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("undecodable_image");
  } finally { restore(); restoreFetch(); }
});

test("upstream 500 and model-shape failures never return a draft", async () => {
  const restore = withEnv();
  try {
    let restoreFetch = mockUpstream(async () => new Response("boom", {status: 500}));
    const res = await proposeImage(authed("http://localhost/api/image-recipe", {image: PNG}));
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("upstream_error");
    restoreFetch();
    restoreFetch = mockUpstream(async () => Response.json({choices: [{finish_reason: "stop",
      message: {content: JSON.stringify({...MUSE_IMAGE_PROPOSAL, materials: "oops"})}}]}));
    const res2 = await proposeImage(authed("http://localhost/api/image-recipe", {image: PNG}));
    expect(res2.status).toBe(502);
    expect((await res2.json()).code).toBe("app_parse");
    restoreFetch();
  } finally { restore(); }
});

const MUSE_GUESSED = {title: "トマトパスタ",
  materials: [
    {name: "ホールトマト", quantity: "200", unit: "g", price_jpy: "300", price_quantity: "400", price_unit: "g", supplier: "○○商店"}],
  selling_price_jpy: "1200", notes: [], interpretations: [], price_research: [],
  name_corrections: []};
function upstreamProposal(proposal: unknown) {
  return mockUpstream(async () => Response.json({choices: [{finish_reason: "stop",
    message: {content: JSON.stringify(proposal)}}]}));
}

test("photo-only guesses never reach the draft as confirmed values", async () => {
  const restore = withEnv();
  const restoreFetch = upstreamProposal(MUSE_GUESSED);
  try {
    const res = await proposeImage(authed("http://localhost/api/image-recipe", {image: PNG}));
    expect(res.status).toBe(200);
    const body = await res.json();
    const material = body.materials[0];
    expect(material.quantity).toBe("");
    expect(material.unit).toBe("");
    expect(material.price_jpy).toBe("");
    expect(material.price_quantity).toBe("");
    expect(material.price_unit).toBe("");
    expect(body.selling_price_jpy).toBe("");
    // Name and supplier are identification hints, not measured facts: kept.
    expect(material.name).toBe("ホールトマト");
    expect(material.supplier).toBe("○○商店");
    expect(body.missing).toContain("ホールトマトの数量・単位");
    expect(body.missing).toContain("ホールトマトの仕入単価・基準数量・単位");
    expect(body.notes.some((note: string) => note.includes("未確定に戻しました"))).toBe(true);
  } finally { restore(); restoreFetch(); }
});

test("memo-stated values are kept; unstated guesses are reset", async () => {
  const restore = withEnv();
  const restoreFetch = upstreamProposal(MUSE_GUESSED);
  try {
    const res = await proposeImage(authed("http://localhost/api/image-recipe",
      {image: PNG, text: "ホールトマト200g、400gで300円仕入れ、売価1200円"}));
    expect(res.status).toBe(200);
    const body = await res.json();
    const material = body.materials[0];
    expect(material.quantity).toBe("200");
    expect(material.unit).toBe("g");
    expect(material.price_jpy).toBe("300");
    expect(material.price_quantity).toBe("400");
    expect(material.price_unit).toBe("g");
    expect(body.selling_price_jpy).toBe("1200");
    expect(body.missing).toEqual([]);
    expect(body.notes.some((note: string) => note.includes("未確定に戻しました"))).toBe(false);
  } finally { restore(); restoreFetch(); }
});

test("memo without the guessed numbers keeps nothing; token boundaries apply", async () => {
  const restore = withEnv();
  const restoreFetch = upstreamProposal(MUSE_GUESSED);
  try {
    const res = await proposeImage(authed("http://localhost/api/image-recipe",
      {image: PNG, text: "トマトパスタです"}));
    expect((await res.json()).materials[0].quantity).toBe("");
    // "2000g" must not confirm a guessed "200": substring is not evidence.
    const res2 = await proposeImage(authed("http://localhost/api/image-recipe",
      {image: PNG, text: "ホールトマト2000g"}));
    const body2 = await res2.json();
    expect(body2.materials[0].quantity).toBe("");
    expect(body2.materials[0].unit).toBe("");
  } finally { restore(); restoreFetch(); }
});

test("unrelated same numbers in the memo are not provenance evidence", async () => {
  const restore = withEnv();
  const restoreFetch = upstreamProposal(MUSE_GUESSED);
  try {
    // "200円" is a price context, not a quantity: quantity must stay unresolved.
    const res = await proposeImage(authed("http://localhost/api/image-recipe",
      {image: PNG, text: "ホールトマト200円"}));
    const body = await res.json();
    expect(body.materials[0].quantity).toBe("");
    expect(body.materials[0].unit).toBe("");
    // Unit alias still counts when row + quantity-unit correspondence holds.
    const res2 = await proposeImage(authed("http://localhost/api/image-recipe",
      {image: PNG, text: "ホールトマト200グラム"}));
    const body2 = await res2.json();
    expect(body2.materials[0].quantity).toBe("200");
    expect(body2.materials[0].unit).toBe("g");
    // Bare "1200円" without a selling-price mention never confirms selling price.
    const res3 = await proposeImage(authed("http://localhost/api/image-recipe",
      {image: PNG, text: "ホールトマト200グラム、1200円"}));
    expect((await res3.json()).selling_price_jpy).toBe("");
    // With the mention, the same number confirms.
    const res4 = await proposeImage(authed("http://localhost/api/image-recipe",
      {image: PNG, text: "ホールトマト200グラム、売価1200円"}));
    expect((await res4.json()).selling_price_jpy).toBe("1200");
  } finally { restore(); restoreFetch(); }
});

const MUSE_TWO_ROWS = {title: "トマトパスタ",
  materials: [
    {name: "トマト", quantity: "20", unit: "g", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""},
    {name: "オリーブオイル", quantity: "20", unit: "g", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
  selling_price_jpy: "", notes: [], interpretations: [], price_research: [],
  name_corrections: []};

test("numbers are attributed to their own row, never borrowed across rows", async () => {
  const restore = withEnv();
  const restoreFetch = upstreamProposal(MUSE_TWO_ROWS);
  try {
    // "20g" belongs to オリーブオイル: the model's トマト "20g" is rejected,
    // オリーブオイル "20g" is kept. Row mention alone is not enough.
    const res = await proposeImage(authed("http://localhost/api/image-recipe",
      {image: PNG, text: "トマト200g、オリーブオイル20g"}));
    const body = await res.json();
    expect(body.materials[0].quantity).toBe("");
    expect(body.materials[0].unit).toBe("");
    expect(body.materials[1].quantity).toBe("20");
    expect(body.materials[1].unit).toBe("g");
    // Same number on two rows: each occurrence confirms its own row.
    const res2 = await proposeImage(authed("http://localhost/api/image-recipe",
      {image: PNG, text: "トマト20g、オリーブオイル20g"}));
    const body2 = await res2.json();
    expect(body2.materials[0].quantity).toBe("20");
    expect(body2.materials[0].unit).toBe("g");
    expect(body2.materials[1].quantity).toBe("20");
    expect(body2.materials[1].unit).toBe("g");
    // Ambiguous correspondence ("each") is fail-closed for the non-owner:
    // "20g" sits with オリーブオイル, so トマト stays unresolved.
    const res3 = await proposeImage(authed("http://localhost/api/image-recipe",
      {image: PNG, text: "トマト、オリーブオイル各20g"}));
    const body3 = await res3.json();
    expect(body3.materials[0].quantity).toBe("");
  } finally { restore(); restoreFetch(); }
});

const MUSE_UNIT = (unit: string) => ({title: "トマトパスタ",
  materials: [
    {name: "トマト", quantity: "200", unit, price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
  selling_price_jpy: "", notes: [], interpretations: [], price_research: [],
  name_corrections: []});

test("the memo unit must match the model's unit, not just the number", async () => {
  const restore = withEnv();
  let restoreFetch = upstreamProposal(MUSE_UNIT("kg"));
  try {
    // Memo "トマト200g" never confirms a guessed "200kg".
    const res = await proposeImage(authed("http://localhost/api/image-recipe",
      {image: PNG, text: "トマト200g"}));
    const body = await res.json();
    expect(body.materials[0].quantity).toBe("");
    expect(body.materials[0].unit).toBe("");
    restoreFetch();
    // Same number and memo with a matching unit stays confirmed.
    restoreFetch = upstreamProposal(MUSE_UNIT("g"));
    const res2 = await proposeImage(authed("http://localhost/api/image-recipe",
      {image: PNG, text: "トマト200g"}));
    const body2 = await res2.json();
    expect(body2.materials[0].quantity).toBe("200");
    expect(body2.materials[0].unit).toBe("g");
  } finally { restore(); restoreFetch(); }
});

const MUSE_SELLING = (selling: string) => ({title: "トマトパスタ",
  materials: [
    {name: "トマト", quantity: "", unit: "", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
  selling_price_jpy: selling, notes: [], interpretations: [], price_research: [],
  name_corrections: []});

test("selling price needs its mention next to the amount", async () => {
  const restore = withEnv();
  let restoreFetch = upstreamProposal(MUSE_SELLING("300"));
  try {
    // Memo "トマト300円、売価1200円": the 売価 mention belongs to 1200,
    // so a guessed selling price of "300" is rejected.
    const res = await proposeImage(authed("http://localhost/api/image-recipe",
      {image: PNG, text: "トマト300円、売価1200円"}));
    expect((await res.json()).selling_price_jpy).toBe("");
    restoreFetch();
    restoreFetch = upstreamProposal(MUSE_SELLING("1200"));
    const res2 = await proposeImage(authed("http://localhost/api/image-recipe",
      {image: PNG, text: "トマト300円、売価1200円"}));
    expect((await res2.json()).selling_price_jpy).toBe("1200");
  } finally { restore(); restoreFetch(); }
});

test("image memo count-unit provenance preserves only matching count facts", async () => {
 const restore=withEnv();
 const proposal={...MUSE_IMAGE_PROPOSAL,materials:[{name:"さくら卵",quantity:"3",unit:"個",price_jpy:"20",price_quantity:"1",price_unit:"個",supplier:""}]};
 const restoreFetch=mockUpstream(async()=>Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify(proposal)}}]}));
 try {
  const matching=await proposeImage(authed("http://localhost/api/image-recipe",{image:PNG,memo:"さくら卵3個、1個20円"}));
  expect(matching.status).toBe(200);
  const good=(await matching.json()).materials[0];
  expect(good.quantity).toBe("3");
  expect(good.unit).toBe("個");
  const mismatching=await proposeImage(authed("http://localhost/api/image-recipe",{image:PNG,memo:"さくら卵3g、1g20円"}));
  expect(mismatching.status).toBe(200);
  const bad=(await mismatching.json()).materials[0];
  expect(bad.quantity).toBe("");
  expect(bad.unit).toBe("");
 } finally {restore();restoreFetch();}
});
