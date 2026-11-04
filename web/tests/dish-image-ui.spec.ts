import {test, expect, type Page} from "@playwright/test";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const draftOne = {title: "カルボナーラ", materials: [
  {name: "卵", quantity: "100", unit: "g", price_jpy: "60", price_quantity: "50", price_unit: "g", supplier: ""}],
  selling_price_jpy: "1800", notes: [], missing: [],
  interpretations: [], price_research: [], name_corrections: [],
  price_references: [], research_status: [], provisional_prices: [null],
  research_state: "complete", pending_research: []};
const draftTwo = {title: "オムライス", materials: [
  {name: "卵", quantity: "100", unit: "g", price_jpy: "60", price_quantity: "50", price_unit: "g", supplier: ""}],
  selling_price_jpy: "900", notes: [], missing: [],
  interpretations: [], price_research: [], name_corrections: [],
  price_references: [], research_status: [], provisional_prices: [null],
  research_state: "complete", pending_research: []};
async function dictate(page: Page, text: string) {
  await page.getByLabel("音声認識できない場合の入力").fill(text);
  await page.getByRole("button", {name: "反映"}).click();
}

test("explicit tap generates a preview; the draft is untouched", async ({page}) => {
  const prompts: string[] = [];
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/voice-recipe", async route => {
    await route.fulfill({json: draftOne});
  });
  await page.route("**/api/dish-image", async route => {
    prompts.push(String(route.request().postDataJSON().prompt ?? ""));
    await blocked;
    await route.fulfill({json: {image: PNG, output_format: "png"}});
  });
  await page.goto("/");
  await dictate(page, "カルボナーラ、卵100グラム");
  await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("カルボナーラ");
  await page.getByRole("button", {name: "✦ 料理画像を生成", exact: true}).click();
  await page.getByLabel("料理イメージの指示（任意）").fill("和風の盛り付け");
  await page.getByRole("button", {name: "✦ 画像を生成", exact: true}).click();
  // Generating state is tied to the actual flight, with a spinner row.
  await expect(page.getByText("料理イメージを生成中…")).toBeVisible();
  release();
  await expect(page.getByAltText("生成した料理イメージ")).toBeVisible();
  await expect(page.getByText("生成画像はイメージです。数量・価格・完成写真の証拠にはなりません。")).toBeVisible();
  // The draft itself is untouched: still unapproved, nothing saved.
  await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("カルボナーラ");
  expect(prompts).toHaveLength(1);
  expect(prompts[0].length).toBeLessThanOrEqual(500);
  expect(prompts[0]).toContain("カルボナーラ");
});

test("generation failure keeps the draft with no preview", async ({page}) => {
  await page.route("**/api/voice-recipe", async route => {
    await route.fulfill({json: draftOne});
  });
  await page.route("**/api/dish-image", async route => {
    await route.fulfill({status: 502, json: {error: "Dish image generation failed", code: "upstream_error"}});
  });
  await page.goto("/");
  await dictate(page, "カルボナーラ、卵100グラム");
  await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("カルボナーラ");
  await page.getByRole("button", {name: "✦ 料理画像を生成", exact: true}).click();
  await page.getByRole("button", {name: "✦ 画像を生成", exact: true}).click();
  // The failure surfaces in the message and the processing-status row.
  await expect(page.getByRole("status", {name: "処理状況"}).getByText("画像の生成に失敗しました。下書きは保持しています。")).toBeVisible();
  await expect(page.getByAltText("生成した料理イメージ")).toHaveCount(0);
  await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("カルボナーラ");
});

test("saving clears the preview so it cannot cross into the next recipe", async ({page}) => {
  let recipes = 0;
  await page.route("**/api/voice-recipe", async route => {
    recipes++;
    await route.fulfill({json: recipes === 1 ? draftOne : draftTwo});
  });
  await page.route("**/api/dish-image", async route => {
    await route.fulfill({json: {image: PNG, output_format: "png"}});
  });
  await page.route("**/api/recipes/full", async route => {
    const body = route.request().postDataJSON();
    await route.fulfill({status: 201, json: {id: body.request_id, title: {value: body.title}, revision: 0, materials: [], selling_price_jpy: {value: body.selling_price_jpy}}});
  });
  await page.goto("/");
  await dictate(page, "カルボナーラ、卵100グラム");
  await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("カルボナーラ");
  await page.getByRole("button", {name: "✦ 料理画像を生成", exact: true}).click();
  await page.getByRole("button", {name: "✦ 画像を生成", exact: true}).click();
  await expect(page.getByAltText("生成した料理イメージ")).toBeVisible();
  await dictate(page, "登録を確定");
  await expect(page.getByRole("region", {name: "レシピ詳細"}).getByRole("heading", {name: "カルボナーラ"})).toBeVisible();
  await page.getByRole("button", {name: "← ホーム"}).click();
  // Saving switches the workspace to browse mode; return to create mode.
  // The next recipe starts clean: no stale preview from the saved one.
  await page.getByRole("button", {name: "登録", exact: true}).click();
  await dictate(page, "オムライス、卵100グラム");
  await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("オムライス");
  // The new draft starts clean: no preview crossed over. The saved recipe's
  // own detail keeps its carried preview outside the draft panel by design.
  await expect(page.locator("#draft").getByAltText("生成した料理イメージ")).toHaveCount(0);
});
