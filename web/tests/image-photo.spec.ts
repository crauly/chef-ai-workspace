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
  await page.getByText("写真からレシピを読み取る（オプション）").click();
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
  await expect(page.getByText("写真を解析中",{exact:true})).toBeVisible();
  release();
  // Same formal path: the existing unsaved-draft card, not a new save route.
  await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("トマトパスタ");
  await expect(page.getByText("要確認：数量・価格は写真から確定できない")).toBeVisible();
  // Human Gate: nothing is saved without an explicit action. Notes make the
  // draft unconfirmed, so one explicit registration saves it as unconfirmed.
  await expect(page.getByRole("button", {name: "レシピを登録", exact: true})).toBeEnabled();
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
  await page.getByText("処理メッセージ").click();
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
  await expect(page.getByRole("status", {name: "音声処理状況"}).getByText("写真解析に失敗")).toBeVisible();
  await expect(page.getByLabel("未保存のレシピ下書き")).toHaveCount(0);
  expect(calls).toBe(1);
  // The failure did not poison the flow: retrying the same photo works.
  fail = false;
  await page.getByRole("button", {name: "写真を解析", exact: true}).click();
  await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("トマトパスタ");
  expect(calls).toBe(2);
});

test("voice draft created during photo analysis wins; photo result is discarded", async ({page}) => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let photoCalls = 0;
  await page.route("**/api/voice-recipe", async route => {
    await route.fulfill({json: voiceDraft});
  });
  await page.route("**/api/image-recipe", async route => {
    photoCalls++;
    await blocked;
    await route.fulfill({json: photoDraft});
  });
  await enterCreate(page);
  await page.getByLabel("解析する写真").setInputFiles(pngFile);
  // Start photo analysis first (no draft yet, so the request is sent)...
  await page.getByRole("button", {name: "写真を解析", exact: true}).click();
  await expect(page.getByText("写真を解析中",{exact:true})).toBeVisible();
  // ...then a voice turn completes while the photo is still in flight.
  await page.getByLabel("音声認識できない場合の入力").fill("パスタ100g");
  await page.getByRole("button", {name: "反映", exact: true}).click();
  await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("ペペロンチーノ");
  // Photo arrives late: it must not clobber the voice draft, and the
  // discard must be explicit, never silent.
  release();
  await page.getByText("処理メッセージ").click();
  await expect(page.getByText("解析中に音声の下書きが作成されたため")).toBeVisible();
  await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("ペペロンチーノ");
  await expect(page.getByLabel("未保存のレシピ下書き")).not.toContainText("トマトパスタ");
  expect(photoCalls).toBe(1);
});

for(const prefix of [false,true])test(`accepted photo clears ${prefix?"voice prefix and persists across reload":"invalidated voice processing status"}`,async({page})=>{
 const gate=()=>{let release!:()=>void;const promise=new Promise<void>(r=>{release=r;});return {promise,release};};
 const photo=gate(),first=gate(),last=gate();let calls=0,completed=0,saves=0;
 await page.route("**/api/recipes/full",route=>{saves++;return route.abort();});
 await page.route("**/api/image-recipe",async route=>{await photo.promise;await route.fulfill({json:photoDraft}).catch(()=>{});});
 await page.route("**/api/voice-recipe",async route=>{
  const n=++calls;await(n===1?first:last).promise;
  await route.fulfill({json:voiceDraft}).catch(()=>{});completed++;
 });
 try{
  await enterCreate(page);await page.getByLabel("解析する写真").setInputFiles(pngFile);
  await page.getByRole("button",{name:"写真を解析",exact:true}).click();
  await expect(page.locator('.voice-status-list [data-stage="photo"]')).toBeVisible();
  const input=page.getByLabel("音声認識できない場合の入力");
  await input.fill("乾燥パスタ100g");await page.getByRole("button",{name:"反映",exact:true}).click();
  await expect.poll(()=>calls).toBe(1);
  if(prefix){
   await input.fill("トマト20gを追加");await page.getByRole("button",{name:"反映",exact:true}).click();
   first.release();await expect(page.getByLabel("未反映の発話")).toBeVisible();
   await expect.poll(()=>calls).toBe(2);
  }
  photo.release();await expect(page.getByLabel("未保存のレシピ下書き")).toContainText(photoDraft.title);
  if(!prefix){first.release();await expect.poll(()=>completed).toBe(1);}
  await expect(page.getByLabel("未反映の発話")).toHaveCount(0);
  await expect(page.locator('.voice-status-list [data-stage="parse"]')).toHaveCount(0);
  // Wait for an actual completed device-cache write, then exercise restoration.
  await expect.poll(()=>page.evaluate(()=>new Promise<string|null>((resolve,reject)=>{
   const open=indexedDB.open("chef-ai-working-draft",1);
   open.onerror=()=>reject(open.error);
   open.onsuccess=()=>{const db=open.result,r=db.transaction("draft","readonly").objectStore("draft").get("current");
    r.onsuccess=()=>{resolve(r.result?.draft?.title??null);db.close();};r.onerror=()=>{reject(r.error);db.close();};};
  }))).toBe(photoDraft.title);
  await page.reload();last.release();
  await page.locator(".voice-quick-modes").getByRole("button",{name:"登録",exact:true}).click();
  await expect(page.getByLabel("未保存のレシピ下書き")).toContainText(photoDraft.title);
  await expect(page.getByLabel("未保存のレシピ下書き")).not.toContainText(voiceDraft.title);
  await expect(page.getByLabel("未反映の発話")).toHaveCount(0);
  await expect(page.locator(".voice-status-list")).toHaveCount(0);expect(saves).toBe(0);
 }finally{first.release();last.release();photo.release();}
});
