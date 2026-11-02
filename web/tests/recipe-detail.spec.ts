import {test, expect, type Page} from "@playwright/test";

test.beforeEach(async ({request}) => {await request.post("http://127.0.0.1:8100/test/reset");});

async function openDetail(page: Page) {
  await page.goto("/");
  await page.getByRole("button", {name: "片栗粉のレシピの詳細を開く"}).click();
  const detail = page.locator("section.recipe-detail");
  await expect(detail).toBeVisible();
  return detail;
}

test("detail shows dish/ingredients/prices, pencil opens modal, qty+price edit saves", async ({page, request}) => {
  const detail = await openDetail(page);
  await expect(detail.getByRole("heading", {name: "片栗粉のレシピ"})).toBeVisible();
  await expect(detail.getByText("片栗粉", {exact: true})).toBeVisible();
  await expect(detail.getByText(/10\s*g/)).toBeVisible();
  await expect(detail.getByText(/仕入単価.*1000.*1kg/)).toBeVisible();
  // Old prompt-based buttons are gone; pencil icon opens the modal.
  await expect(detail.getByRole("button", {name: "数量変更"})).toHaveCount(0);
  await expect(detail.getByRole("button", {name: "単価変更"})).toHaveCount(0);
  // Unsaved dish-image preview starts with a placeholder and no generated image.
  await expect(detail.getByRole("region", {name: "料理イメージ"}).getByText("料理画像はまだありません")).toBeVisible();
  await expect(detail.getByRole("region", {name: "料理イメージ"}).locator("img")).toHaveCount(0);

  // Quantity edit via modal.
  await detail.getByRole("button", {name: "片栗粉を編集"}).click();
  const dialog = page.getByRole("dialog", {name: "片栗粉を編集"});
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/現在.*10\s*g/)).toBeVisible();
  await expect(dialog.getByText(/1000.*1kg/)).toBeVisible();
  await dialog.getByLabel("数量", {exact: true}).fill("15");
  await expect(dialog.getByText(/変更後.*15\s*g/)).toBeVisible();
  await dialog.getByRole("button", {name: "変更して保存"}).click();
  await expect(dialog).toBeHidden();
  await expect(detail.getByText(/15\s*g/)).toBeVisible();
  let state = await (await request.get("http://127.0.0.1:8100/test/state")).json();
  expect(JSON.stringify(state.confirms)).toContain("set_material_quantity");

  // Price edit via modal.
  await detail.getByRole("button", {name: "片栗粉を編集"}).click();
  const dialog2 = page.getByRole("dialog", {name: "片栗粉を編集"});
  await dialog2.getByLabel("仕入単価（円）", {exact: true}).fill("1200");
  await dialog2.getByRole("button", {name: "変更して保存"}).click();
  await expect(dialog2).toBeHidden();
  await expect(detail.getByText(/仕入単価.*1200/)).toBeVisible();
  state = await (await request.get("http://127.0.0.1:8100/test/state")).json();
  expect(JSON.stringify(state.confirms)).toContain("set_material_price");
});

test("AI consult expands only on demand; mobile shows detail without overflow", async ({page}) => {
  const detail = await openDetail(page);
  // AI editor stays collapsed until the consult button is pressed.
  await expect(page.getByLabel("料理人の指示", {exact: true})).toBeHidden();
  await detail.getByRole("button", {name: "◇ AIに変更相談"}).click();
  await expect(page.getByLabel("料理人の指示", {exact: true})).toBeVisible();
  await detail.getByRole("button", {name: "◇ AIに変更相談"}).click();
  await expect(page.getByLabel("料理人の指示", {exact: true})).toBeHidden();

  await page.setViewportSize({width: 390, height: 844});
  await expect(detail.getByRole("button", {name: "片栗粉を編集"})).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
