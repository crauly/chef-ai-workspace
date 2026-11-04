import {test,expect} from "@playwright/test";
test("voice recipe with unknown prices saves explicitly as price-unconfirmed",async({page})=>{
 let saved=0;let body:any=null;let recipe:any=null;
 await page.route("**/api/recipes/*",route=>recipe&&route.request().method()==="GET"&&route.request().url().endsWith(recipe.id)?route.fulfill({json:recipe}):route.fallback());
 const draft={title:"カルボナーラ",materials:[{name:"卵",quantity:"100",unit:"g",price_jpy:"",price_quantity:"",price_unit:""}],selling_price_jpy:"1800",notes:[],missing:["卵の仕入単価・基準数量・単位"]};
 await page.route("**/api/voice-recipe",async route=>{
  await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(draft)});
 });
 await page.route("**/api/recipes/full",async route=>{
  saved++;body=route.request().postDataJSON();
  expect(body.materials).toHaveLength(1);
  expect(body.materials[0].quantity).toBe("100");
  expect(body.materials[0].price_jpy).toBeNull();
  expect(body.materials[0].price_quantity).toBeNull();
  expect(body.materials[0].price_unit).toBeNull();
  recipe={id:body.request_id,title:{value:body.title,status:"confirmed"},revision:0,materials:[],selling_price_jpy:{value:body.selling_price_jpy,status:"confirmed"}};
  await route.fulfill({status:201,contentType:"application/json",body:JSON.stringify(recipe)});
 });
 await page.goto("/");
 const entry=page.getByLabel("音声認識できない場合の入力");
 await entry.fill("カルボナーラ、卵100グラム、値段はわかりません");
 await page.getByRole("button",{name:"反映"}).click();
 await expect(page.getByText("未保存の下書き：カルボナーラ")).toBeVisible();
 await expect(page.getByText("仕入価格 未設定")).toBeVisible();
 // The unknown price stays unconfirmed, yet the draft is explicitly registrable.
 await expect(page.getByRole("button",{name:"レシピを登録"})).toBeEnabled();
 expect(saved).toBe(0);
 // One explicit save commits with prices omitted, not zero-filled.
 await entry.fill("保存してください");await page.getByRole("button",{name:"反映"}).click();
 await expect(page.getByRole("region", {name: "レシピ詳細"})).toBeVisible();
 await expect(page.getByRole("heading",{name:"カルボナーラ",exact:true})).toBeVisible();
 await page.reload();
 await expect(page.getByRole("heading",{name:"カルボナーラ",exact:true})).toBeVisible();
 expect(saved).toBe(1);
});

test("a confirmed voice recipe forwards its approved supplier and survives reload", async ({page}) => {
 // Supplier resolution is part of the explicitly approved atomic save.
 let saved = 0; let body: any = null; let recipe: any = null;
 await page.route("**/api/recipes/*",route=>recipe&&route.request().method()==="GET"&&route.request().url().endsWith(recipe.id)?route.fulfill({json:recipe}):route.fallback());
 const draft = {title: "ペペロンチーノ", materials: [{name: "ディチェコ パスタ", quantity: "100", unit: "g", price_jpy: "350", price_quantity: "500", price_unit: "g", supplier: "築地場外"}], selling_price_jpy: "1800", notes: [], missing: []};
 await page.route("**/api/voice-recipe", route => route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(draft)}));
 await page.route("**/api/recipes/full", async route => {
  saved++; body = route.request().postDataJSON();
  recipe = {id: body.request_id, title: {value: body.title, status: "confirmed"}, revision: 0, materials: [], selling_price_jpy: {value: body.selling_price_jpy, status: "confirmed"}};
  await route.fulfill({status: 201, contentType: "application/json", body: JSON.stringify(recipe)});
 });
 await page.goto("/");
 const entry = page.getByLabel("音声認識できない場合の入力");
 await entry.fill("ペペロンチーノ、ディチェコのパスタ100グラム、500グラム350円、築地場外");
 await page.getByRole("button", {name: "反映"}).click();
 await expect(page.getByText("未保存の下書き：ペペロンチーノ")).toBeVisible();
 await expect(page.getByText("仕入先: 築地場外")).toBeVisible();
 expect(saved).toBe(0);
 // One explicit save includes the approved purchase source.
 await entry.fill("保存してください"); await page.getByRole("button", {name: "反映"}).click();
 await expect(page.getByRole("region", {name: "レシピ詳細"})).toBeVisible();
 await expect(page.getByRole("heading",{name:"ペペロンチーノ",exact:true})).toBeVisible();
 await page.reload();
 await expect(page.getByRole("heading",{name:"ペペロンチーノ",exact:true})).toBeVisible();
 expect(saved).toBe(1);
 // The approved save forwards the supplier for atomic owner-scoped resolution.
 expect(body.materials).toHaveLength(1);
 expect(body.materials[0].supplier).toBe("築地場外");
 expect(body.materials[0]).toMatchObject({name: "ディチェコ パスタ", quantity: "100", unit: "g", price_jpy: "350"});
});

test("incremental parsing stays active past thirty turns without losing context", async ({page}) => {
 const bodies: any[] = [];
 const draft = {title: "長期カレー", materials: [], selling_price_jpy: "", notes: [], missing: ["長期カレーの仕入単価・基準数量・単位"]};
 await page.route("**/api/voice-recipe", async route => {
  bodies.push(route.request().postDataJSON());
  await route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(draft)});
 });
 await page.goto("/");
 const entry = page.getByLabel("音声認識できない場合の入力");
 const reflect = page.getByRole("button", {name: "反映"});
 for (let i = 1; i <= 33; i++) {
  await entry.fill(`具材${i}を10グラム`);
  await reflect.click();
 }
 await page.locator(".voice-transcript summary").click();
 await expect(page.getByText("具材33を10グラム", {exact: true})).toBeVisible();
 // Past turn 30 the newest turn must still arrive with the accumulated draft
 // as context (absolute cursor), never a history-only resend without it.
 await expect.poll(() => {
  const last = bodies[bodies.length - 1];
  return last && typeof last === "object" && "previous" in last && (last as any).previous?.title === "長期カレー" ? "incremental" : "stalled";
 }, {timeout: 8000}).toBe("incremental");
});
