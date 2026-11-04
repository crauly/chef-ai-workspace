import {test, expect, type Page} from "@playwright/test";

async function microphone(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {value: async () => {
      const context = new AudioContext(), source = context.createOscillator(), gain = context.createGain(), output = context.createMediaStreamDestination();
      gain.gain.value = .1; source.connect(gain); gain.connect(output); source.start(); await context.resume();
      return output.stream;
    }});
  });
}

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
  await page.getByRole("dialog",{name:"レシピと食材マスターの保存確認"}).getByRole("button",{name:"承認して保存",exact:true}).click();
  await expect(dialog).toBeHidden();
  await expect(detail.getByText(/15\s*g/)).toBeVisible();
  let state = await (await request.get("http://127.0.0.1:8100/test/state")).json();
  expect(JSON.stringify(state.confirms)).toContain("set_material_quantity");

  // Price edit via modal.
  await detail.getByRole("button", {name: "片栗粉を編集"}).click();
  const dialog2 = page.getByRole("dialog", {name: "片栗粉を編集"});
  await dialog2.getByLabel("仕入単価（円）", {exact: true}).fill("1200");
  await dialog2.getByRole("button", {name: "変更して保存"}).click();
  await page.getByRole("dialog",{name:"レシピと食材マスターの保存確認"}).getByRole("button",{name:"承認して保存",exact:true}).click();
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
 await expect(page.locator(".detail-topbar .detail-revision")).toHaveCount(0);
 await expect(page.getByRole("button",{name:"← ホーム"})).toBeVisible();
 await expect(page.locator("#voice-controls")).toBeVisible();
 await expect(page.locator("img[src='/chef-ai-mark.svg']")).toBeVisible();
 await page.reload();
 await expect(page.getByRole("heading",{name:"片栗粉のレシピ"})).toBeVisible();
 await page.getByRole("button",{name:"← ホーム"}).click();
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
 await recipe.scrollIntoViewIfNeeded();
 await expect(recipe).toBeInViewport();
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

// Real routes unmount the voice capture, so opening a recipe mid-recording
// must refuse with a notice instead of silently discarding in-flight audio.
// The recording stays stoppable on the current page; opening works after stop.
test("opening a recipe mid-recording preserves capture and stays stoppable",async({page})=>{
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
 await expect(page).toHaveURL(/\/recipes\/[^/]+$/);
 await expect(page.getByRole("button",{name:"■ マイクを停止",exact:true})).toBeVisible();
 await page.getByRole("button",{name:"■ マイクを停止",exact:true}).click();
});

test("clearing a supplier applies before the market price edit", async ({page}) => {
  const recipeId = "11111111-1111-4111-8111-111111111111";
  const supplierId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let saved: Record<string, any> | undefined;
  let operations: Record<string, string>[] = [];
  await page.route(`**/api/recipes/${recipeId}`, async route => {
    if (!saved) {
      saved = await (await route.fetch()).json();
      const line = saved!.materials[0];
      line.price_mode = "inherit";
      line.ingredient_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      line.supplier_id = supplierId;
      line.offer_id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
      line.effective_price = line.price_override;
      line.price_override = null;
    }
    await route.fulfill({json: saved});
  });
  await page.route("**/api/suppliers?*", route => route.fulfill({json: {items: [{id: supplierId, name: "仕入れ先A"}]}}));
  await page.route("**/api/ingredients/*/offer-prices", route => route.fulfill({json: {items: []}}));
  await page.route(`**/api/recipes/${recipeId}/confirm`, async route => {
    operations = route.request().postDataJSON().operations;
    const line = saved!.materials[0];
    for (const op of operations) {
      if (op.op === "set_material_supplier") {line.supplier_id = op.supplier_id || null; line.offer_id = op.offer_id || null;}
      if (op.op === "set_material_price") {
        if (line.supplier_id || line.offer_id) return route.fulfill({status: 409, json: {detail: "Supplier price forbidden"}});
        line.effective_price = {amount_jpy: {value: op.price_jpy, status: "confirmed", origin: "user"}, per_quantity: op.price_quantity, per_unit: op.price_unit};
      }
    }
    saved!.revision++;
    await route.fulfill({json: {recipe: saved}});
  });
  const detail = await openDetail(page);
  await detail.getByRole("button", {name: "片栗粉を編集"}).click();
  const dialog = page.getByRole("dialog", {name: "片栗粉を編集"});
  await dialog.getByRole("combobox", {name: "仕入先", exact: true}).selectOption("");
  await dialog.getByLabel("仕入単価（円）", {exact: true}).fill("1200");
  await dialog.getByLabel("単価の基準数量").fill("1");await dialog.getByRole("combobox",{name:"Price unit",exact:true}).selectOption("kg");
  await dialog.getByRole("button", {name: "変更して保存"}).click();
  await page.getByRole("dialog",{name:"レシピと食材マスターの保存確認"}).getByRole("button",{name:"承認して保存",exact:true}).click();
  await expect(dialog).toBeHidden();
  expect(operations.map(op => op.op)).toEqual(["set_material_supplier", "set_material_price"]);
  await expect(detail.getByText(/仕入単価.*1200/)).toBeVisible();
});

test("independent detail route keeps selected recipe bound to voice edit", async ({page}) => {
 const detail = await openDetail(page);
 await expect(page).toHaveURL(/\/recipes\/[^/]+$/);
 await expect(page.locator(".recipe-library-section")).toHaveCount(0);
 await expect(detail.getByRole("heading", {name: "片栗粉のレシピ"})).toBeVisible();
 await detail.getByRole("button", {name: "🎙 音声でレシピを修正"}).click();
 await expect(page.locator("#voice-controls")).toBeVisible();
 await expect(page.locator("#voice-controls")).toContainText("現在のモード: 編集");
 await expect(page.locator("#voice-controls")).toContainText("片栗粉のレシピ");
 await expect(page.getByRole("button", {name: /音声操作を開始/})).toBeVisible();
 await page.reload();
 await expect(page.locator(".recipe-library-section")).toHaveCount(0);
 await expect(page.getByRole("heading", {name: "片栗粉のレシピ"})).toBeVisible();
});

test("detail voice edit by another recipe name navigates on single match", async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await microphone(page);
  await page.route("**/api/voice/transcribe", route => route.fulfill({json: {transcript: "ミートソースパスタを編集して"}}));
  const detail = await openDetail(page);
  await expect(detail.getByRole("heading", {name: "片栗粉のレシピ"})).toBeVisible();
  await page.getByRole("button", {name: "下部の音声操作"}).click();
  await expect(page.getByRole("button", {name: /マイクを停止/}).first()).toBeVisible();
  // The mocked mic streams silence until the audio worklet delivers voiced
  // frames; stopping instantly would correctly drop an empty capture with no
  // transcription. Settle briefly so the stop carries actual audio.
  await page.waitForTimeout(2500);
  await page.getByRole("button", {name: /マイクを停止/}).first().click();
  await expect(page.getByRole("heading", {name: "ミートソースパスタ"})).toBeVisible();
  await expect(page).toHaveURL(/\/recipes\/[^/]+$/);
  await expect(page.locator("#voice-controls")).toBeVisible();
  await expect(page.locator("#voice-controls")).toContainText("現在のモード: 編集");
  await expect(page.locator("#voice-controls")).toContainText("ミートソースパスタ");
  await expect(page).toHaveURL(/\/recipes\/[^/?]+$/); // One-time edit hint is consumed.
});

test("home Edit mode asks for a recipe, then opens its detail route in edit mode",async({page,request})=>{
 await microphone(page);
 await page.route("**/api/voice/transcribe",route=>route.fulfill({json:{transcript:"片栗粉を15gに変更して"}}));
 await page.goto("/");
 await page.getByRole("group",{name:"操作モード"}).getByRole("button",{name:"編集"}).click();
 await expect(page.locator("#voice-controls")).toContainText("現在のモード: 参照");
 await expect(page.locator("#voice-controls")).toContainText("編集するレシピを検索して選択してください。");
 await page.getByRole("button",{name:"片栗粉のレシピの詳細を開く"}).click();
 await expect(page).toHaveURL(/\/recipes\/[^/?]+$/);
 await expect(page.getByRole("heading",{name:"片栗粉のレシピ"})).toBeVisible();
 await expect(page.locator("#voice-controls")).toContainText("現在のモード: 編集");
 await expect(page.locator("#voice-controls")).toContainText("片栗粉のレシピ");
 await page.getByRole("button",{name:"🎙 音声操作を開始",exact:true}).click();
 await expect(page.getByRole("button",{name:/マイクを停止/}).first()).toBeVisible();
 await page.waitForTimeout(2500);
 await page.getByRole("button",{name:/マイクを停止/}).first().click();
 await expect(page.getByLabel("提案の差分")).toBeVisible();
 let state=await (await request.get("http://127.0.0.1:8100/test/state")).json();
 expect(state.confirms).toHaveLength(0);
 await page.locator(".proposal input[type=checkbox]").check();
 await page.locator(".proposal .actions button").first().click();
 await expect(page.getByRole("region",{name:"Recipe cost summary"})).toContainText("¥15");
 state=await (await request.get("http://127.0.0.1:8100/test/state")).json();
 expect(state.confirms).toHaveLength(1);
});

test("home voice edit keeps edit intent when the user selects among multiple recipes",async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await microphone(page);
 await page.route("**/api/voice/transcribe",route=>route.fulfill({json:{transcript:"スを編集して"}}));
 await page.goto("/");
 await page.getByRole("button",{name:"下部の音声操作"}).click();
 await expect(page.getByRole("button",{name:/マイクを停止/}).first()).toBeVisible();
 // The fixture microphone emits voiced frames only after AudioWorklet startup.
 await page.waitForTimeout(2500);
 await page.getByRole("button",{name:/マイクを停止/}).first().click();
 await expect(page.getByRole("button",{name:/ミートソースパスタの詳細を開く/})).toBeVisible();
 await expect(page.getByRole("button",{name:/きのこのクリームスープの詳細を開く/})).toBeVisible();
 await page.getByRole("button",{name:"ミートソースパスタの詳細を開く"}).click();
 await expect(page).toHaveURL(/\/recipes\/[^/?]+$/);
 await expect(page.getByRole("heading",{name:"ミートソースパスタ"})).toBeVisible();
 await expect(page.locator("#voice-controls")).toContainText("現在のモード: 編集");
 await expect(page.locator("#voice-controls")).toContainText("ミートソースパスタ");
});

test("detail voice edit with no match keeps the current recipe", async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await microphone(page);
  await page.route("**/api/voice/transcribe", route => route.fulfill({json: {transcript: "存在しない料理を編集して"}}));
  const detail = await openDetail(page);
  const url = page.url();
  await expect(detail.getByRole("heading", {name: "片栗粉のレシピ"})).toBeVisible();
  await page.getByRole("button", {name: "下部の音声操作"}).click();
  await expect(page.getByRole("button", {name: /マイクを停止/}).first()).toBeVisible();
  // The mocked mic streams silence until the audio worklet delivers voiced
  // frames; stopping instantly would correctly drop an empty capture with no
  // transcription. Settle briefly so the stop carries actual audio.
  await page.waitForTimeout(2500);
  await page.getByRole("button", {name: /マイクを停止/}).first().click();
  await expect(page.getByText("編集対象を一つに絞れませんでした。検索結果から選んでください。")).toBeVisible();
  await expect(page.locator("#voice-controls")).toBeVisible();
  await expect(page).toHaveURL(url);
  await expect(detail.getByRole("heading", {name: "片栗粉のレシピ"})).toBeVisible();
});

test("detail voice edit with multiple matches lets the user choose a target", async ({page}) => {
  // "ス" matches both ミートソースパスタ and きのこのクリームスープ, sharing the
  // same length!==1 branch as the no-match case: feedback, no navigation, waiter released.
  await page.setViewportSize({width: 390, height: 844});
  await microphone(page);
  await page.route("**/api/voice/transcribe", route => route.fulfill({json: {transcript: "スを編集して"}}));
  const detail = await openDetail(page);
  const url = page.url();
  await expect(detail.getByRole("heading", {name: "片栗粉のレシピ"})).toBeVisible();
  await page.getByRole("button", {name: "下部の音声操作"}).click();
  await expect(page.getByRole("button", {name: /マイクを停止/}).first()).toBeVisible();
  // The mocked mic streams silence until the audio worklet delivers voiced
  // frames; stopping instantly would correctly drop an empty capture with no
  // transcription. Settle briefly so the stop carries actual audio.
  await page.waitForTimeout(2500);
  await page.getByRole("button", {name: /マイクを停止/}).first().click();
  await expect(page.getByText("編集対象を一つに絞れませんでした。検索結果から選んでください。")).toBeVisible();
  await expect(page.locator("#voice-controls")).toBeVisible();
  await expect(page).toHaveURL(url);
  await expect(detail.getByRole("heading", {name: "片栗粉のレシピ"})).toBeVisible();
  await page.getByRole("region",{name:"レシピ検索結果"}).getByRole("button",{name:"きのこのクリームスープの詳細を開く"}).click();
  await expect(page).toHaveURL(/\/recipes\/[^/?]+$/);
  await expect(page.getByRole("heading",{name:"きのこのクリームスープ"})).toBeVisible();
  await expect(page.locator("#voice-controls")).toContainText("現在のモード: 編集");
  await expect(page.locator("#voice-controls")).toContainText("きのこのクリームスープ");
});

test("detail candidates cannot discard a pending proposal on the displayed recipe",async({page,request})=>{
 await page.setViewportSize({width:390,height:844});
 await microphone(page);
 await page.route("**/api/voice/transcribe",route=>route.fulfill({json:{transcript:"スを編集して"}}));
 const detail=await openDetail(page);
 const url=page.url();
 await page.getByRole("button",{name:"下部の音声操作"}).click();
 await expect(page.getByRole("button",{name:/マイクを停止/}).first()).toBeVisible();
 await page.waitForTimeout(2500);
 await page.getByRole("button",{name:/マイクを停止/}).first().click();
 const results=page.getByRole("region",{name:"レシピ検索結果"});
 await expect(results).toBeVisible();
 await detail.getByRole("button",{name:"◇ AIに変更相談"}).click();
 await page.locator("#ai-instruction").fill("片栗粉を15gに変更");
 await page.locator(".instruction-form button").last().click();
 await expect(page.getByLabel("提案の差分")).toBeVisible();
 await results.getByRole("button",{name:"ミートソースパスタの詳細を開く"}).click();
 await expect(detail.getByRole("alert")).toContainText("未保存の変更案があります");
 await expect(page).toHaveURL(url);
 await expect(page.getByLabel("提案の差分")).toBeVisible();
 const state=await (await request.get("http://127.0.0.1:8100/test/state")).json();
 expect(state.confirms).toHaveLength(0);
});

test("detail voice edit candidates paginate beyond the first 20 results",async({page,request})=>{
 await request.post("http://127.0.0.1:8100/test/search-fixtures");
 await page.setViewportSize({width:390,height:844});
 await microphone(page);
 await page.route("**/api/voice/transcribe",route=>route.fulfill({json:{transcript:"別の料理を編集して"}}));
 await page.goto("/recipes/11111111-1111-4111-8111-111111111111");
 await expect(page.getByRole("heading",{name:"片栗粉のレシピ"})).toBeVisible();
 await page.getByRole("button",{name:"下部の音声操作"}).click();
 await expect(page.getByRole("button",{name:/マイクを停止/}).first()).toBeVisible();
 await page.waitForTimeout(2500);
 await page.getByRole("button",{name:/マイクを停止/}).first().click();
 const results=page.getByRole("region",{name:"レシピ検索結果"});
 await expect(results.getByRole("button",{name:/の詳細を開く/})).toHaveCount(20);
 await expect(results.getByRole("button",{name:"次へ"})).toBeEnabled();
 await results.getByRole("button",{name:"次へ"}).click();
 await expect(results.getByRole("button",{name:/の詳細を開く/})).toHaveCount(1);
 await expect(results).toContainText("別の料理20");
 await expect(results).toContainText("ページ 2");
 const state=await (await request.get("http://127.0.0.1:8100/test/state")).json();
 expect(state.listQueries).toContainEqual({q:"別の料理",page:2});
});

test("ordinary detail reload after rename does not show unrelated recipe candidates",async({page,request})=>{
 const detail=await openDetail(page);
 const before=await (await request.get("http://127.0.0.1:8100/test/state")).json();
 const rename=detail.locator("details.detail-action").filter({hasText:"料理名を変更"});
 await rename.locator("summary").click();
 await rename.locator("form input").fill("片栗粉のレシピ 改訂");
 await rename.locator("form button").click();
 await expect.poll(async()=>{
  const current=await (await request.get("http://127.0.0.1:8100/test/state")).json();
  return current.listQueries.length;
 }).toBeGreaterThan(before.listQueries.length);
 await expect(page.getByRole("region",{name:"レシピ検索結果"})).toHaveCount(0);
});


test("missing detail recipe shows an error and a usable return path",async({page})=>{
 await page.goto("/recipes/99999999-9999-4999-8999-999999999999");
 await expect(page.getByRole("alert")).toBeVisible();
 await expect(page.getByRole("button",{name:"← ホーム"})).toBeVisible();
 await page.getByRole("button",{name:"← ホーム"}).click();
 await expect(page).toHaveURL("/");
 await expect(page.getByRole("button",{name:"片栗粉のレシピの詳細を開く"})).toBeVisible();
});

test("partial-cost diagnostics honor a stored material price override",async({page})=>{
 const materialId="22222222-2222-4222-8222-222222222222";
 await page.route("**/api/recipes/*/cost",route=>route.fulfill({json:{
  partial:true,subtotal_jpy:"0",line_costs:{},unresolved_line_ids:[materialId],
  total_cost_jpy:null,cost_rate_pct:null,estimated:false
 }}));
 const detail=await openDetail(page);
 await expect(detail.getByText("単位換算を確認")).toBeVisible();
 await expect(detail.getByText("採用価格が未設定")).toHaveCount(0);
});

test("detail opens in browse mode before any voice edit request",async({page})=>{
 const detail=await openDetail(page);
 await expect(detail.getByRole("heading",{name:"片栗粉のレシピ"})).toBeVisible();
 await expect(page.locator("#voice-controls")).toContainText("現在のモード: 参照");
 await expect(page.locator("#voice-controls")).toBeVisible();
});

test("long-press edit action opens the actual detail editor",async({page})=>{
 await page.goto("/");
 const recipe=page.getByRole("button",{name:"片栗粉のレシピの詳細を開く"});
 await recipe.click({button:"right"});
 await page.getByRole("dialog",{name:"レシピの操作"}).getByRole("button",{name:"編集"}).click();
 await expect(page).toHaveURL(/\/recipes\/[^/?]+$/);
 await expect(page.getByRole("heading",{name:"片栗粉のレシピ"})).toBeVisible();
 await expect(page.getByLabel("料理人の指示",{exact:true})).toBeVisible();
});


test("detail bulk price research proposes every selected row but cannot save without approval",async({page})=>{
 const recipeId="11111111-1111-4111-8111-111111111111";
 let confirmations=0;
 let researchMaterials: {id:string;material_name:{value:string}}[]=[];
 await page.route(`**/api/recipes/${recipeId}`,async route=>{
  const recipe=await (await route.fetch()).json();
  recipe.materials=[
   {...recipe.materials[0],id:"22222222-2222-4222-8222-222222222222",material_name:{value:"小麦粉",status:"confirmed"}},
   {...recipe.materials[0],id:"33333333-3333-4333-8333-333333333333",material_name:{value:"バター",status:"confirmed"}},
   {...recipe.materials[0],id:"44444444-4444-4444-8444-444444444444",material_name:{value:"牛乳",status:"confirmed"}},
  ];
  researchMaterials=recipe.materials;
  await route.fulfill({json:recipe});
 });
 await page.route("**/api/recipe-price-research",async route=>{
  const body=route.request().postDataJSON();
  expect(body.instruction).toContain("すべて");
  expect(body.recipe_id).toBe(recipeId);
  expect(body.base_revision).toBe(0);
  expect(researchMaterials.map(m=>m.material_name.value)).toEqual(["小麦粉","バター","牛乳"]);
  await route.fulfill({json:{
   ambiguous:false,indices:[0,1,2],
   operations:[
    {op:"set_material_price",material_id:researchMaterials[0].id,price_jpy:"0.8",price_quantity:"1",price_unit:"g"},
    {op:"set_material_price",material_id:researchMaterials[1].id,price_jpy:"2",price_quantity:"1",price_unit:"g"},
    {op:"set_material_price",material_id:researchMaterials[2].id,price_jpy:"0.3",price_quantity:"1",price_unit:"ml"}
   ],
   edit_instruction:"",
   results:researchMaterials.map((m,i)=>({index:i,name:m.material_name.value,status:"candidate",description:"仕入調査の参考価格・要確認"}))
  }});
 });
 await page.route(`**/api/recipes/${recipeId}/confirm`,route=>{
  confirmations++;return route.fulfill({status:409,json:{detail:"Not expected before approval"}});
 });
 const detail=await openDetail(page);
 await detail.getByRole("button",{name:"◇ AIに変更相談"}).click();
 await page.locator("#ai-instruction").fill("すべての材料の市場価格を調べて仮単価を入れて");
 await page.locator(".instruction-form button").last().click();
 await expect(page.locator(".proposal ol li")).toHaveCount(3);
 await expect(page.getByText("調査根拠・未取得の理由")).toBeVisible();
 expect(confirmations).toBe(0);
 await expect(page.locator(".proposal button").first()).toBeDisabled();
});

test("detail price scope ambiguity creates no mutation proposal",async({page})=>{
 await page.route("**/api/recipe-price-research",route=>route.fulfill({json:{indices:[],operations:[],results:[],ambiguous:true}}));
 const detail=await openDetail(page);
 await detail.getByRole("button",{name:"◇ AIに変更相談"}).click();
 await page.locator("#ai-instruction").fill("この材料の価格を調べて");
 await page.locator(".instruction-form button").last().click();
 await expect(page.getByText(/調査対象を特定できませんでした/)).toBeVisible();
 await expect(page.locator(".proposal")).toHaveCount(0);
});

test("bulk research preserves other edits and retries the exact approved proposal",async({page})=>{
 const recipeId="11111111-1111-4111-8111-111111111111",materialId="22222222-2222-4222-8222-222222222222";
 const attempts:{request_id:string;operations:Record<string,string>[]}[]=[];
 let saved:Record<string,any>|undefined;
 await page.route(`**/api/recipes/${recipeId}`,async route=>{
  saved??=await (await route.fetch()).json();return route.fulfill({json:saved});
 });
 await page.route("**/api/recipe-price-research",route=>route.fulfill({json:{indices:[0],ambiguous:false,
  edit_instruction:"片栗粉の使用量を15gに変更、売価を1800円に変更",
  operations:[{op:"set_material_price",material_id:materialId,price_jpy:"0.7600",price_quantity:"1",price_unit:"g"}],
  results:[{index:0,name:"片栗粉",status:"candidate",description:"未承認の仮単価",
   reference:{origin:"external",observation_count:1,fetched_at:"2026-11-04",sources:[{url:"https://shop.example/product",title:"販売元の原文"}],
    currency:"JPY",samples:[{name:"片栗粉",seller:"販売元A",amount:"380",package:"500g",tax_note:"税込",shipping_note:"別途",url:"https://shop.example/product"}]}}]}}));
 await page.route(`**/api/recipes/${recipeId}/propose`,route=>{
  const {instruction}=route.request().postDataJSON();expect(instruction).toContain("15g");expect(instruction).not.toContain("価格");
  return route.fulfill({json:{recipe_id:recipeId,base_revision:0,requires_confirmation:true,operations:[
   {op:"set_material_quantity",material_id:materialId,value:"15",unit:"g"},
   {op:"set_selling_price",value_jpy:"1800"},
   {op:"set_material_price",material_id:materialId,price_jpy:"999",price_quantity:"1",price_unit:"g"}]}});
 });
 await page.route(`**/api/recipes/${recipeId}/confirm`,route=>{
  const body=route.request().postDataJSON();attempts.push(body);
  if(attempts.length===1)return route.fulfill({status:502,json:{error:"uncertain save"}});
  saved!.revision=1;saved!.materials[0].quantity.value="15";saved!.selling_price_jpy.value="1800";
  return route.fulfill({json:{recipe:saved}});
 });
 const detail=await openDetail(page);await detail.getByRole("button",{name:"◇ AIに変更相談"}).click();
 await page.locator("#ai-instruction").fill("片栗粉の価格を調べて、使用量を15g、売価を1800円に変更");
 await page.locator(".instruction-form button").last().click();
 await expect(page.locator(".proposal ol li")).toHaveCount(3);
 await expect(page.locator(".proposal ol")).toContainText("15");await expect(page.locator(".proposal ol")).not.toContainText("999");
 await expect(page.getByRole("link",{name:"販売元の原文"})).toHaveAttribute("href","https://shop.example/product");
 expect(attempts).toHaveLength(0);await expect(page.locator(".proposal button").first()).toBeDisabled();
 await page.locator(".proposal input[type=checkbox]").check();await page.locator(".proposal button").first().click();
 await expect.poll(()=>attempts.length).toBe(1);await expect(page.locator(".ai-workspace .error")).toBeVisible();
 await page.locator(".proposal button").first().click();await expect.poll(()=>attempts.length).toBe(2);
 expect(attempts[1].request_id).toBe(attempts[0].request_id);expect(attempts[1].operations).toEqual(attempts[0].operations);
 expect(attempts[0].operations.map(op=>op.op)).toEqual(["set_material_quantity","set_selling_price","set_material_price"]);
 expect(attempts[0].operations[2].price_jpy).toBe("0.7600");
});

test("detail browse voice research opens an unapproved price proposal",async({page})=>{
 await page.setViewportSize({width:390,height:844});await microphone(page);
 let confirms=0,ordinaryProposals=0;
 await page.route("**/api/voice/transcribe",route=>route.fulfill({json:{transcript:"すべての材料の価格を調べて"}}));
 await page.route("**/api/recipe-price-research",route=>route.fulfill({json:{indices:[0],ambiguous:false,edit_instruction:"",
  operations:[{op:"set_material_price",material_id:"22222222-2222-4222-8222-222222222222",price_jpy:"0.8",price_quantity:"1",price_unit:"g"}],
  results:[{index:0,name:"片栗粉",status:"candidate",description:"仕入履歴の仮単価・要確認"}]}}));
 await page.route("**/propose",route=>{ordinaryProposals++;return route.fulfill({status:503,json:{error:"unexpected"}});});
 await page.route("**/confirm",route=>{confirms++;return route.fulfill({status:409,json:{error:"unapproved"}});});
 await openDetail(page);await expect(page.locator("#voice-controls")).toBeVisible();
 await page.getByRole("button",{name:"下部の音声操作"}).click();await page.waitForTimeout(2500);
 await page.getByRole("button",{name:/マイクを停止/}).first().click();
 await expect(page.locator(".proposal ol li")).toHaveCount(1);await expect(page.locator("#voice-controls")).toBeVisible();
 expect(confirms).toBe(0);expect(ordinaryProposals).toBe(0);await expect(page.locator(".proposal button").first()).toBeDisabled();
});

test("English detail returns Home without a REV badge",async({page})=>{
 await openDetail(page);await page.getByLabel("Display language").selectOption("en-US");
 await expect(page.getByRole("button",{name:"← Home",exact:true})).toBeVisible();
 await expect(page.locator(".detail-topbar")).not.toContainText("REV");
 await page.getByRole("button",{name:"← Home",exact:true}).click();await expect(page).toHaveURL("/");
});

test("stale research refreshes the selected recipe and requires a new proposal",async({page})=>{
 const recipeId="11111111-1111-4111-8111-111111111111";let reads=0;
 await page.route(`**/api/recipes/${recipeId}`,async route=>{
  const recipe=await (await route.fetch()).json();recipe.revision=reads++?1:0;return route.fulfill({json:recipe});
 });
 await page.route("**/api/recipe-price-research",route=>route.fulfill({status:409,json:{error:"Stale recipe"}}));
 const detail=await openDetail(page);await detail.getByRole("button",{name:"◇ AIに変更相談"}).click();
 await page.locator("#ai-instruction").fill("すべての食材の価格を調べて");await page.locator(".instruction-form button").last().click();
 await expect(page.getByText("最新のレシピを取得しました。変更案を作り直してください。")).toBeVisible();
 await expect(page.locator(".proposal")).toHaveCount(0);expect(reads).toBeGreaterThanOrEqual(2);
});

test("material cost display rounds to one decimal without changing backend values",async({page})=>{
 const recipeId="11111111-1111-4111-8111-111111111111";
 await page.route(`**/api/recipes/${recipeId}/cost`,route=>
  route.fulfill({json:{
   total_cost_jpy:"28.888888888888889",subtotal_jpy:"28.888888888888889",
   cost_rate_pct:null,partial:false,line_costs:{},unresolved_line_ids:[]
  }}));
 const detail=await openDetail(page);
 await expect(detail.getByRole("region",{name:"Recipe cost summary"})).toContainText("¥28.9");
 await expect(detail.getByRole("region",{name:"Recipe cost summary"})).not.toContainText("28.88888");
});
