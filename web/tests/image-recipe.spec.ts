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
