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

test("recipe detail has standalone URL, clean top viewport, and supports reload and back", async ({page}) => {
 await page.setViewportSize({width:390,height:844});
 await page.goto("/");
 await page.getByRole("button",{name:"片栗粉のレシピの詳細を開く"}).click();
 await expect(page).toHaveURL(/\/recipes\/[^/]+$/);
 await expect(page.getByRole("heading",{name:"片栗粉のレシピ"})).toBeVisible();
 await expect(page.locator("#voice-controls")).toBeHidden();
 await expect(page.locator("img[src='/chef-ai-mark.svg']")).toBeVisible();
 await page.reload();
 await expect(page.getByRole("heading",{name:"片栗粉のレシピ"})).toBeVisible();
 await page.getByRole("button",{name:"← レシピ一覧"}).click();
 await expect(page).toHaveURL("/");
 await expect(page.getByRole("button",{name:"片栗粉のレシピの詳細を開く"})).toBeVisible();
});

test("recipe detail supports explicit deletion with confirmation",async({page})=>{
 const detail=await openDetail(page);
 let calls=0;
 await page.route("**/api/recipes/*",async route=>{
  if(route.request().method()==="DELETE"){calls++;return route.fulfill({json:{deleted:true}});}
  return route.continue();
 });
 await detail.getByRole("button",{name:"レシピを削除"}).click();
 const dialog=page.getByRole("dialog",{name:"レシピ削除の確認"});
 await expect(dialog).toBeVisible();
 expect(calls).toBe(0);
 await dialog.getByRole("button",{name:"キャンセル"}).click();
 expect(calls).toBe(0);
 await detail.getByRole("button",{name:"レシピを削除"}).click();
 await dialog.getByRole("button",{name:"削除する"}).click();
 await expect.poll(()=>calls).toBe(1);
 await expect(page).toHaveURL("/");
});

test("long press on recipe list opens edit/delete without navigating",async({page})=>{
 await page.goto("/");
 const recipe=page.getByRole("button",{name:"片栗粉のレシピの詳細を開く"});
 const bounds=await recipe.boundingBox();
 expect(bounds).not.toBeNull();
 await page.mouse.move(bounds!.x+bounds!.width/2,bounds!.y+bounds!.height/2);
 await page.mouse.down();
 await page.waitForTimeout(650);
 await page.mouse.up();
 const actions=page.getByRole("dialog",{name:"レシピの操作"});
 await expect(actions).toBeVisible();
 await expect(page).toHaveURL("/");
 await expect(actions.getByRole("button",{name:"編集"})).toBeVisible();
 await expect(actions.getByRole("button",{name:"削除"})).toBeVisible();
 await actions.getByRole("button",{name:"キャンセル"}).click();
 await recipe.click();
 await expect(page).toHaveURL(/\/recipes\/[^/]+$/);
});

test("ongoing recording stays stoppable after opening a recipe on desktop",async({page})=>{
 await page.setViewportSize({width:1280,height:800});
 await page.addInitScript(()=>{
  Object.defineProperty(navigator.mediaDevices,"getUserMedia",{value:async()=>{
   const context=new AudioContext(),oscillator=context.createOscillator(),gain=context.createGain();
   const destination=context.createMediaStreamDestination();
   oscillator.connect(gain);gain.connect(destination);gain.gain.value=.0001;
   oscillator.start();await context.resume();return destination.stream;
  }});
 });
 await page.goto("/");
 await page.getByRole("button",{name:/音声操作を開始/}).click();
 await expect(page.getByRole("button",{name:"■ マイクを停止"})).toBeVisible();
 await page.getByRole("button",{name:"片栗粉のレシピの詳細を開く"}).click();
 await expect(page.locator("#voice-controls")).toBeHidden();
 const recording=page.locator(".recipe-voice-capture-status");
 await expect(recording).toBeVisible();
 await recording.getByRole("button",{name:"マイクを停止"}).click();
 await expect(recording).toBeHidden();
});
