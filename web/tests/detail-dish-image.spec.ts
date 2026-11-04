import {test, expect, type Page} from "@playwright/test";

const IMG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test.beforeEach(async ({request}) => {await request.post("http://127.0.0.1:8100/test/reset");});

async function openRecipe(page: Page, title: string) {
  await page.goto("/");
  await page.getByRole("button", {name: `${title}の詳細を開く`}).click();
  const detail = page.locator("section.recipe-detail");
  await expect(detail.getByRole("heading", {name: title})).toBeVisible();
  return detail;
}

test("empty state shows placeholder, generate succeeds, enlarge closes", async ({page}) => {
  await page.route("**/api/dish-image", route => route.fulfill({json: {image: IMG}}));
  const detail = await openRecipe(page, "片栗粉のレシピ");
  const section = detail.getByRole("region", {name: "料理イメージ"});
  await expect(section.getByText("料理画像はまだありません")).toBeVisible();
  await expect(section.getByText("レシピとは別に画像を保存します")).toBeVisible();
  await expect(section.locator("img")).toHaveCount(0);
  await section.getByRole("button", {name: "✦ 料理画像を生成"}).click();
  await expect(section.getByRole("img", {name: "生成した料理イメージ"})).toBeVisible();
  await expect(section.getByRole("button", {name: "↻ 再生成"})).toBeVisible();
  // Enlarge via tap, close via button.
  await section.getByRole("button", {name: "料理イメージを拡大表示"}).click();
  const dialog = page.getByRole("dialog", {name: "料理イメージの拡大表示"});
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", {name: "閉じる"}).click();
  await expect(dialog).toBeHidden();
  // Enlarge again, close via Escape.
  await section.getByRole("button", {name: "料理イメージを拡大表示"}).click();
  await expect(page.getByRole("dialog", {name: "料理イメージの拡大表示"})).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", {name: "料理イメージの拡大表示"})).toBeHidden();
});

test("failure shows retry, regenerate issues a fresh request", async ({page}) => {
  let calls = 0;
  await page.route("**/api/dish-image", route => {
    calls++;
    if (calls === 1) return route.fulfill({status: 502, json: {error: "Dish image generation failed", code: "upstream_error"}});
    return route.fulfill({json: {image: IMG}});
  });
  const detail = await openRecipe(page, "片栗粉のレシピ");
  const section = detail.getByRole("region", {name: "料理イメージ"});
  await section.getByRole("button", {name: "✦ 料理画像を生成"}).click();
  await expect(section.getByText("画像の生成に失敗しました")).toBeVisible();
  await expect(section.locator("img")).toHaveCount(0);
  await section.getByRole("button", {name: "再試行"}).click();
  await expect(section.getByRole("img", {name: "生成した料理イメージ"})).toBeVisible();
  expect(calls).toBe(2);
  await section.getByRole("button", {name: "↻ 再生成"}).click();
  await expect(section.getByRole("img", {name: "生成した料理イメージ"})).toBeVisible();
  expect(calls).toBe(3);
});

test("stale response from a previous recipe is discarded on switch", async ({page}) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  await page.route("**/api/dish-image", async route => {await gate; await route.fulfill({json: {image: IMG}});});
  const detail = await openRecipe(page, "片栗粉のレシピ");
  const section = detail.getByRole("region", {name: "料理イメージ"});
  await section.getByRole("button", {name: "✦ 料理画像を生成"}).click();
  await expect(section.getByText("画像を生成中")).toBeVisible();
  // Switch recipes while the first flight is still pending.
  await detail.getByRole("button", {name: "← ホーム"}).click();
  await page.getByRole("button", {name: "ミートソースパスタの詳細を開く"}).click();
  const pasta = page.locator("section.recipe-detail");
  await expect(pasta.getByRole("heading", {name: "ミートソースパスタ"})).toBeVisible();
  release();
  await page.waitForTimeout(300);
  const pastaSection = pasta.getByRole("region", {name: "料理イメージ"});
  await expect(pastaSection.locator("img")).toHaveCount(0);
  await expect(pastaSection.getByText("料理画像はまだありません")).toBeVisible();
});

test("390px mobile layout without overflow, edit flow intact", async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await page.route("**/api/dish-image", route => route.fulfill({json: {image: IMG}}));
  const detail = await openRecipe(page, "きのこのクリームスープ");
  const section = detail.getByRole("region", {name: "料理イメージ"});
  await section.getByRole("button", {name: "✦ 料理画像を生成"}).click();
  await expect(section.getByRole("img", {name: "生成した料理イメージ"})).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({path: "test-results/dish-image-390px.png"});
  // Existing edit modal still opens beside the new section.
  await detail.getByRole("button", {name: "牛乳を編集"}).click();
  await expect(page.getByRole("dialog", {name: "牛乳を編集"})).toBeVisible();
});

test("generated image is retained in cloud across reloads", async ({page}) => {
 let stored=false;
 await page.route("**/api/recipe-images/*",route=>{
  if(route.request().method()==="POST"){stored=true;return route.fulfill({json:{saved:true}});}
  return stored?route.fulfill({json:{image:IMG}}):route.fulfill({status:404,json:{error:"Not found"}});
 });
 await page.route("**/api/dish-image",route=>route.fulfill({json:{image:IMG,mode:"generate"}}));
 const detail=await openRecipe(page,"片栗粉のレシピ");
 const section=detail.getByRole("region",{name:"料理イメージ"});
 await section.getByRole("button",{name:"✦ 料理画像を生成"}).click();
 await expect(section.getByText("クラウドに保存済み · 他端末でも表示できます")).toBeVisible();
 await page.reload();
 await expect(page.getByRole("region",{name:"料理イメージ"}).getByRole("img",{name:"生成した料理イメージ"})).toBeVisible();
});
