import {test, expect, type Page} from "@playwright/test";
import {NextRequest} from "next/server";
import {POST as generateDish} from "../app/api/dish-image/route";
import {isPlateImageValid, loadPlate, parsePlateDataUrl, sanitizePlateNote, savePlate, clearPlate, PLATE_STORAGE_KEY, PLATE_MAX_BYTES, type PlateStorage} from "../app/plate-settings";

const PASSWORD = "test-only-preview-password-32-characters";
const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
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
function memStore(): PlateStorage & {dump: () => string | null} {
  let value: string | null = null;
  return {
    getItem: () => value, setItem: (_k: string, v: string) => { value = v; }, removeItem: () => { value = null; },
    dump: () => value,
  };
}

test("plate photo validation accepts jpeg/png/webp and rejects anything else", async () => {
  expect(parsePlateDataUrl(TINY_PNG)?.mime).toBe("image/png");
  expect(parsePlateDataUrl("data:image/jpeg;base64,/9j/4AAQ")?.mime).toBe("image/jpeg");
  expect(parsePlateDataUrl("data:image/webp;base64,UklGRg==")?.mime).toBe("image/webp");
  for (const bad of ["", "not-a-url", "data:image/gif;base64,R0lGOD==", "data:image/svg+xml;base64,PHN2Zz4=", "data:text/plain;base64,aGk=", "data:image/png;base64,!!!", "data:image/png;QUJD"]) {
    expect(parsePlateDataUrl(bad)).toBeNull();
    expect(isPlateImageValid(bad)).toBe(false);
  }
  expect(isPlateImageValid(TINY_PNG)).toBe(true);
});

test("oversized plate photos are rejected before any upload", async () => {
  const overBytes = PLATE_MAX_BYTES + 1;
  const b64len = Math.ceil(overBytes / 3) * 4;
  const huge = "data:image/jpeg;base64," + "A".repeat(b64len);
  expect(isPlateImageValid(huge)).toBe(false);
  expect(parsePlateDataUrl(huge)).not.toBeNull();
});

test("note is trimmed and capped, never stored raw", async () => {
  expect(sanitizePlateNote("  白い丸皿  ")).toBe("白い丸皿");
  expect(sanitizePlateNote("x".repeat(500)).length).toBeLessThanOrEqual(200);
  expect(sanitizePlateNote(undefined)).toBe("");
});

test("save/load/clear round-trips one plate; corrupt data resets to empty", async () => {
  const store = memStore();
  expect(loadPlate(store)).toEqual({image: null, note: ""});
  savePlate({image: TINY_PNG, note: " 白い丸皿 "}, store);
  expect(loadPlate(store)).toEqual({image: TINY_PNG, note: "白い丸皿"});
  expect(() => savePlate({image: "data:image/gif;base64,R0lGOD==", note: ""}, store)).toThrow();
  clearPlate(store);
  expect(loadPlate(store)).toEqual({image: null, note: ""});
  store.setItem(PLATE_STORAGE_KEY, "{broken");
  expect(loadPlate(store)).toEqual({image: null, note: ""});
});

test("route forwards a plate photo to images/edits as multipart, never generations", async () => {
  const restore = withEnv();
  const seen: {url: string; multipart: boolean; model: unknown; prompt: unknown; hasImage: boolean}[] = [];
  const done = mockUpstream(async (url: unknown, init: unknown) => {
    const body = (init as {body?: unknown}).body;
    const form = body as FormData;
    seen.push({url: String(url), multipart: typeof form?.get === "function",
      model: typeof form?.get === "function" ? form.get("model") : null,
      prompt: typeof form?.get === "function" ? form.get("prompt") : null,
      hasImage: typeof form?.get === "function" && form.get("image") instanceof Blob});
    return Response.json({output_format: "png", data: [{b64_json: "UVJD"}]});
  });
  try {
    const res = await generateDish(authed("http://localhost/api/dish-image", {prompt: "トマトパスタ", image: TINY_PNG}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.image).toBe("data:image/png;base64,UVJD");
    expect(body.mode).toBe("edit");
    expect(seen.length).toBe(1);
    expect(seen[0].url).toContain("/v1/images/edits");
    expect(seen[0].multipart).toBe(true);
    expect(seen[0].model).toBe("muse-image-1.0");
    expect(seen[0].prompt).toBe("トマトパスタ");
    expect(seen[0].hasImage).toBe(true);
  } finally { restore(); done(); }
});

test("route without a plate still uses generations and reports its mode", async () => {
  const restore = withEnv();
  let url = "";
  const done = mockUpstream(async (u: unknown, init: unknown) => {
    url = String(u);
    expect(String((init as {body?: unknown}).body ?? "")).toContain("muse-image-1.0");
    return Response.json({output_format: "png", data: [{b64_json: "QUJD"}]});
  });
  try {
    const res = await generateDish(authed("http://localhost/api/dish-image", {prompt: "トマトパスタ"}));
    expect(res.status).toBe(200);
    expect((await res.json()).mode).toBe("generate");
    expect(url).toContain("/v1/images/generations");
  } finally { restore(); done(); }
});

test("route rejects invalid plate images before any upstream call", async () => {
  const restore = withEnv();
  let called = false;
  const done = mockUpstream(async () => { called = true; return Response.json({}); });
  try {
    for (const image of ["data:image/gif;base64,R0lGOD==", "not-a-url", 42, "data:image/png;base64,!!!"]) {
      const res = await generateDish(authed("http://localhost/api/dish-image", {prompt: "トマトパスタ", image}));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("invalid_image");
    }
    expect(called).toBe(false);
  } finally { restore(); done(); }
});

test("edit-path upstream failure keeps the draft-safe error contract", async () => {
  const restore = withEnv();
  try {
    let done = mockUpstream(async () => new Response("boom", {status: 500}));
    const res = await generateDish(authed("http://localhost/api/dish-image", {prompt: "トマトパスタ", image: TINY_PNG}));
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe("upstream_error");
    done();
    done = mockUpstream(async () => Response.json({data: []}));
    const res2 = await generateDish(authed("http://localhost/api/dish-image", {prompt: "トマトパスタ", image: TINY_PNG}));
    expect(res2.status).toBe(502);
    expect((await res2.json()).code).toBe("bad_response");
    done();
  } finally { restore(); }
});

test.beforeEach(async ({request}) => {await request.post("http://127.0.0.1:8100/test/reset");});

async function openRecipe(page: Page, title: string) {
  await page.goto("/");
  await page.getByRole("button", {name: `${title}の詳細を開く`}).click();
  const detail = page.locator("section.recipe-detail");
  await expect(detail.getByRole("heading", {name: title})).toBeVisible();
  return detail;
}

test("settings section is reachable from the library view and starts empty", async ({page}) => {
  await page.goto("/");
  const settings = page.locator("details.plate-settings");
  await expect(settings.getByText("料理画像設定（デフォルト皿）")).toBeVisible();
  await settings.getByText("料理画像設定（デフォルト皿）").click();
  await expect(settings.getByText("皿は未登録です")).toBeVisible();
  await expect(settings.getByRole("button", {name: "保存"})).toBeDisabled();
});

test("detail section reports plate status and attaches the photo on generate", async ({page}) => {
  await page.addInitScript(({key, image}) => {
    localStorage.setItem(key, JSON.stringify({image, note: "白い丸皿"}));
  }, {key: PLATE_STORAGE_KEY, image: TINY_PNG});
  let sentBody = "";
  await page.route("**/api/dish-image", route => {
    sentBody = String(route.request().postData() ?? "");
    return route.fulfill({json: {image: TINY_PNG, mode: "edit"}});
  });
  await page.goto("/");
  const detail = await openRecipe(page, "片栗粉のレシピ");
  const section = detail.getByRole("region", {name: "料理イメージ"});
  await expect(section.getByText("デフォルト皿を使用します")).toBeVisible();
  await section.getByRole("button", {name: "✦ 料理画像を生成"}).click();
  await expect(section.getByRole("img", {name: "生成した料理イメージ"})).toBeVisible();
  const sent = JSON.parse(sentBody);
  expect(sent.image).toBe(TINY_PNG);
  expect(typeof sent.prompt).toBe("string");
});

test("detail section without a plate reports standard generation and sends no photo", async ({page}) => {
  let sentBody = "";
  await page.route("**/api/dish-image", route => {
    sentBody = String(route.request().postData() ?? "");
    return route.fulfill({json: {image: TINY_PNG, mode: "generate"}});
  });
  const detail = await openRecipe(page, "片栗粉のレシピ");
  const section = detail.getByRole("region", {name: "料理イメージ"});
  await expect(section.getByText("デフォルト皿未登録")).toBeVisible();
  await section.getByRole("button", {name: "✦ 料理画像を生成"}).click();
  await expect(section.getByRole("img", {name: "生成した料理イメージ"})).toBeVisible();
  expect(JSON.parse(sentBody).image).toBeUndefined();
});
