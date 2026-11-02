import {test, expect} from "@playwright/test";
import {NextRequest} from "next/server";
import {POST as generateDish} from "../app/api/dish-image/route";
import {dishImagePrompt, isAbortError, dishCompletionKept} from "../app/VoiceRecipeRegistration";

const PASSWORD = "test-only-preview-password-32-characters";
function authed(url: string, body: unknown) {
  return new NextRequest(url, {method: "POST",
    headers: {Origin: "http://localhost",
      Authorization: "Basic " + Buffer.from("chef:" + PASSWORD).toString("base64")},
    body: JSON.stringify(body)});
}
function withEnv() {
  const saved = {password: process.env.DEMO_PREVIEW_PASSWORD, key: process.env.MODEL_API_KEY};
  process.env.DEMO_PREVIEW_PASSWORD = PASSWORD; process.env.MODEL_API_KEY = "fixture-key";
  return () => {
    if (saved.password === undefined) delete process.env.DEMO_PREVIEW_PASSWORD; else process.env.DEMO_PREVIEW_PASSWORD = saved.password;
    if (saved.key === undefined) delete process.env.MODEL_API_KEY; else process.env.MODEL_API_KEY = saved.key;
  };
}
function mockUpstream(handler: (url: unknown, init: unknown) => unknown) {
  const previousFetch = global.fetch;
  global.fetch = handler as typeof fetch;
  return () => { global.fetch = previousFetch; };
}

test("prompt helper builds from draft title, ingredients, and explicit hint", async () => {
  const prompt = dishImagePrompt("トマトパスタ", ["ホールトマト", "乾燥パスタ"], "和風の盛り付け");
  expect(prompt).toContain("トマトパスタ");
  expect(prompt).toContain("ホールトマト");
  expect(prompt).toContain("和風の盛り付け");
  expect(dishImagePrompt("", [], "")).toContain("unspecified dish");
  // Hint is capped so the upstream prompt stays short.
  expect(dishImagePrompt("t", ["a"], "x".repeat(500)).length).toBeLessThan(500);
});

test("empty or oversized prompts are rejected before any upstream call", async () => {
  const restore = withEnv();
  let called = false;
  const done = mockUpstream(async () => { called = true; return Response.json({}); });
  try {
    for (const body of [{prompt: ""}, {prompt: "   "}, {prompt: "x".repeat(501)}, {}]) {
      const res = await generateDish(authed("http://localhost/api/dish-image", body));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("invalid_prompt");
    }
    expect(called).toBe(false);
  } finally { restore(); done(); }
});

test("missing API key is reported as unavailable", async () => {
  const restore = withEnv();
  delete process.env.MODEL_API_KEY;
  const done = mockUpstream(async () => Response.json({}));
  try {
    const res = await generateDish(authed("http://localhost/api/dish-image", {prompt: "トマトパスタ"}));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("unavailable");
  } finally { restore(); done(); }
});

test("base64 payload returns a preview data URL; url payload passes through", async () => {
  const restore = withEnv();
  let sentBody = "";
  let done = mockUpstream(async (_url: unknown, init: unknown) => {
    sentBody = String((init as {body?: unknown}).body ?? "");
    return Response.json({output_format: "png", data: [{b64_json: "QUJD"}]});
  });
  try {
    const res = await generateDish(authed("http://localhost/api/dish-image", {prompt: "トマトパスタ"}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.image).toBe("data:image/png;base64,QUJD");
    // Single-shot contract: exactly one image per call.
    const sent = JSON.parse(sentBody);
    expect(sent.model).toBe("muse-image-1.0");
    expect(sent.n).toBe(1);
    done();
    done = mockUpstream(async () => Response.json({output_format: "png", data: [{url: "https://example.com/i.png"}]}));
    const res2 = await generateDish(authed("http://localhost/api/dish-image", {prompt: "トマトパスタ"}));
    expect(res2.status).toBe(200);
    expect((await res2.json()).image).toBe("https://example.com/i.png");
  } finally { restore(); done(); }
});

test("upstream failure and bad shape are distinguished, never a preview", async () => {
  const restore = withEnv();
  try {
    let done = mockUpstream(async () => new Response("boom", {status: 500}));
    const res = await generateDish(authed("http://localhost/api/dish-image", {prompt: "トマトパスタ"}));
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("upstream_error");
    done();
    done = mockUpstream(async () => Response.json({data: []}));
    const res2 = await generateDish(authed("http://localhost/api/dish-image", {prompt: "トマトパスタ"}));
    expect(res2.status).toBe(502);
    expect((await res2.json()).code).toBe("bad_response");
    done();
  } finally { restore(); }
});

test("combined prompt never exceeds the route 500-char cap", async () => {
  // Review example shape: 14-char title + eight 39-char names + 200-char
  // hint = 584 chars uncapped, which the route would always reject.
  const long = dishImagePrompt(
    "トマトパスタの特別仕立て",
    Array.from({length: 8}, (_, i) => `n${i}-` + "x".repeat(36)),
    "x".repeat(200));
  expect(long.length).toBeLessThanOrEqual(500);
  // Intent survives the budget: title head stays, request is non-empty.
  expect(long).toContain("トマトパスタ");
  expect(long.length).toBeGreaterThan(0);
  // All callers share the plated-food-only harness.
  const natural = dishImagePrompt("t", ["a"], "clean serving");
  expect(natural).toContain("finished plated dish");
  expect(natural).toContain("No raw or scattered ingredients, packaging");
  expect(natural).toContain("clean serving");
});

test("abort is cancellation, not failure; stale results never land", async () => {
  // fetch-abort rejects with DOMException AbortError; HTTP failures arrive
  // as Error("<status>") from request() and must still display.
  expect(isAbortError(new DOMException("aborted", "AbortError"))).toBe(true);
  expect(isAbortError(new Error("504"))).toBe(false);
  expect(isAbortError(null)).toBe(false);
  const draft = {};
  // Only the exact draft object the flight started from accepts the result.
  expect(dishCompletionKept(draft, draft, false)).toBe(true);
  expect(dishCompletionKept(draft, {}, false)).toBe(false);
  expect(dishCompletionKept(draft, null, false)).toBe(false);
  expect(dishCompletionKept(null, draft, false)).toBe(false);
  expect(dishCompletionKept(draft, draft, true)).toBe(false);
});
