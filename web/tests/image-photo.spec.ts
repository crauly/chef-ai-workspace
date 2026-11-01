import {test, expect, type Page} from "@playwright/test";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const pngFile = {name: "dish.png", mimeType: "image/png", buffer: Buffer.from(PNG_B64, "base64")};
// Photo proposal: quantities unknown (server strips guesses), notes block approval.
const photoDraft = {title: "トマトパスタ", materials: [
  {name: "ホールトマト", quantity: "", unit: "", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
  selling_price_jpy: "", notes: ["数量・価格は写真から確定できない"], missing: ["ホールトマトの数量・単位", "ホールトマトの仕入単価・基準数量・単位"],
  interpretations: [], price_research: [], name_corrections: [],
  price_references: [], research_status: [], provisional_prices: [null],
  research_state: "deferred", pending_research: []};
const voiceDraft = {title: "ペペロンチーノ", materials: [
  {name: "乾燥パスタ", quantity: "100", unit: "g", price_jpy: "", price_quantity: "", price_unit: "", supplier: ""}],
  selling_price_jpy: "", notes: [], missing: ["乾燥パスタの仕入単価・基準数量・単位"],
  interpretations: [], price_research: [], name_corrections: [],
  price_references: [], research_status: [], provisional_prices: [null],
  research_state: "deferred", pending_research: []};
async function enterCreate(page: Page) {
  await page.goto("/");
  await page.getByRole("button", {name: "登録", exact: true}).click();
  await expect(page.getByRole("button", {name: "写真を解析", exact: true})).toBeVisible();
}

test("photo analysis reaches the existing unsaved draft path with its gate intact", async ({page}) => {
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const saves: unknown[] = [];
  await page.route("**/api/image-recipe", async route => {
    calls++;
    const body = route.request().postDataJSON();
    expect(String(body.image).startsWith("data:image/png;base64,")).toBe(true);
    expect(body.text).toBe("トマトパスタ");
    await blocked;
    await route.fulfill({json: photoDraft});
  });
  await page.route("**/api/recipes/full", async route => {
    saves.push(route.request().postDataJSON());
    await route.fulfill({status: 201, json: {id: "r1", title: {value: "x"}, revision: 0, materials: [], selling_price_jpy: {value: null}}});
  });
  await enterCreate(page);
  await page.getByLabel("写真のメモ（任意）").fill("トマトパスタ");
  await page.getByLabel("解析する写真").setInputFiles(pngFile);
  await page.getByRole("button", {name: "写真を解析", exact: true}).click();
  // Analyzing state is tied to the actual flight, with a spinner row.
  await expect(page.getByText("写真を解析中…")).toBeVisible();
  release();
  // Same formal path: the existing unsaved-draft card, not a new save route.
  await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("トマトパスタ");
  await expect(page.getByText("要確認：数量・価格は写真から確定できない")).toBeVisible();
  // Human Gate: unresolved notes keep review and approval disabled; nothing saved.
  await expect(page.getByRole("button", {name: "内容を確認", exact: true})).toBeDisabled();
  await expect(page.getByRole("button", {name: "内容を承認して保存", exact: true})).toBeDisabled();
  expect(calls).toBe(1);
  expect(saves).toEqual([]);
});

test("photo analysis never overwrites an existing draft", async ({page}) => {
  await page.route("**/api/voice-recipe", async route => {
    await route.fulfill({json: voiceDraft});
  });
  let photoCalls = 0;
  await page.route("**/api/image-recipe", async route => {
    photoCalls++;
    await route.fulfill({json: photoDraft});
  });
  await enterCreate(page);
  await page.getByLabel("音声認識できない場合の入力").fill("パスタ100g");
  await page.getByRole("button", {name: "反映", exact: true}).click();
  await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("ペペロンチーノ");
  await page.getByLabel("解析する写真").setInputFiles(pngFile);
  await page.getByRole("button", {name: "写真を解析", exact: true}).click();
  // Refused before any request: the draft cannot be clobbered.
  await expect(page.getByText("既存の下書きがあります")).toBeVisible();
  expect(photoCalls).toBe(0);
  await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("ペペロンチーノ");
});

test("photo failure creates no draft and keeps the panel usable", async ({page}) => {
  let calls = 0;
  let fail = true;
  await page.route("**/api/image-recipe", async route => {
    calls++;
    if (fail) await route.fulfill({status: 502, json: {error: "Image recipe proposal failed", code: "upstream_error"}});
    else await route.fulfill({json: photoDraft});
  });
  await enterCreate(page);
  await page.getByLabel("解析する写真").setInputFiles(pngFile);
  await page.getByRole("button", {name: "写真を解析", exact: true}).click();
  await expect(page.getByRole("status", {name: "処理状況"}).getByText("写真の解析に失敗しました")).toBeVisible();
  await expect(page.getByLabel("未保存のレシピ下書き")).toHaveCount(0);
  expect(calls).toBe(1);
  // The failure did not poison the flow: retrying the same photo works.
  fail = false;
  await page.getByRole("button", {name: "写真を解析", exact: true}).click();
  await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("トマトパスタ");
  expect(calls).toBe(2);
});
