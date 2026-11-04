import {voiceInput} from "./voice-input";
import {test,expect,type Page} from "@playwright/test";

const draft={title:"アマトリチャーナ",materials:[
 {name:"乾燥パスタ",quantity:"100",unit:"g",price_jpy:"350",price_quantity:"500",price_unit:"g"},
 {name:"トマト",quantity:"200",unit:"g",price_jpy:"300",price_quantity:"1",price_unit:"kg"},
],selling_price_jpy:"",notes:[],missing:[],interpretations:[]};
const input = voiceInput;
test.beforeEach(async({request})=>{await request.post("http://127.0.0.1:8100/test/reset");});
const starchDraft={title:"片栗粉のレシピ",materials:[{name:"片栗粉",quantity:"10",unit:"g",price_jpy:"1000",price_quantity:"1",price_unit:"kg"}],selling_price_jpy:"1000",missing:[],notes:[]};

test("draft survives browse transition and review routes back to the draft",async({page})=>{
 let parses=0,saves=0;
 await page.route("**/api/voice-recipe",route=>{parses++;return route.fulfill({json:draft});});
 await page.route("**/api/recipes/full",async route=>{
  saves++;const body=route.request().postDataJSON();
  await route.fulfill({status:201,json:{id:body.request_id,title:{value:body.title},revision:0,materials:[],selling_price_jpy:{value:null}}});
 });
 await page.goto("/");
 await input(page,"アマトリチャーナ。乾燥パスタ100g、500g350円。トマト200g、1kg300円");
 await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("アマトリチャーナ");
 await page.locator(".voice-quick-modes").getByRole("button",{name:"参照",exact:true}).click();
 await expect(page.getByText("登録途中の下書きを保持しています。")).toBeVisible();
 // Review from browse must return to the pending draft, not start a new search.
 await input(page,"内容を確認");
 await expect(page.getByLabel("未保存のレシピ下書き")).toBeVisible();
 expect(parses).toBe(1);
 await expect(page.getByText("登録途中の下書きを保持しています。")).toHaveCount(0);
 // The routed review presents the draft for approval without a new Muse parse.
 await expect(page.getByRole("button",{name:"承認して保存",exact:true})).toBeEnabled();
 expect(parses).toBe(1);
 // An explicit save after the presented review commits through the normal gate.
 await input(page,"保存してください");
 await expect(page.getByRole("region", {name: "レシピ詳細"})).toBeVisible();
 expect(saves).toBe(1);
});

test("transcription and Muse failures keep the draft",async({page})=>{
 let failNextParse=true;
 await page.route("**/api/voice-recipe",route=>{
  if(failNextParse){failNextParse=false;return route.abort();}
  return route.fulfill({json:draft});
 });
 await page.goto("/");
 await input(page,"アマトリチャーナ。乾燥パスタ100g");
 await page.getByText("処理メッセージ").click();
 await expect(page.getByText("料理の解釈に失敗しました。")).toBeVisible();
 await input(page,"トマト200g、1kg300円");
 await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("アマトリチャーナ");
});

test("browsing recipe detail and returning home keeps the unsaved registration",async({page})=>{
 await page.route("**/api/voice-recipe",route=>route.fulfill({json:starchDraft}));
 await page.goto("/");
 await input(page,"片栗粉10g、1kg1000円");
 await expect(page.getByLabel("未保存のレシピ下書き")).toBeVisible();
 await page.locator(".voice-quick-modes").getByRole("button",{name:"参照",exact:true}).click();
 await expect(page.getByText("登録途中の下書きを保持しています。")).toBeVisible();
 await input(page,"片栗粉のレシピを見せて");
 await expect(page.getByRole("region",{name:"Recipe cost summary"})).toBeVisible();
 await page.getByRole("button",{name:"← ホーム",exact:true}).click();
 await page.getByRole("group",{name:"操作モード"}).getByRole("button",{name:"登録",exact:true}).click();
 await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("片栗粉");
 await input(page,"内容を確認");
 await expect(page.getByLabel("正式登録の確認")).toBeVisible();
});

test("explicit cancel clears the draft while plain transitions keep it",async({page})=>{
 let parses=0;
 await page.route("**/api/voice-recipe",route=>{parses++;return route.fulfill({json:draft});});
 await page.goto("/");
 await input(page,"アマトリチャーナ。乾燥パスタ100g、500g350円");
 await expect(page.getByLabel("未保存のレシピ下書き")).toBeVisible();
 await page.locator(".voice-quick-modes").getByRole("button",{name:"参照",exact:true}).click();
 await expect(page.getByText("登録途中の下書きを保持しています。")).toBeVisible();
 await page.locator(".voice-quick-modes").getByRole("button",{name:"登録",exact:true}).click();
 await expect(page.getByLabel("未保存のレシピ下書き")).toBeVisible();
 expect(parses).toBe(1);
 await input(page,"キャンセル");
 await expect(page.getByLabel("未保存のレシピ下書き")).toHaveCount(0);
 await page.locator(".voice-quick-modes").getByRole("button",{name:"参照",exact:true}).click();
 await expect(page.getByText("登録途中の下書きを保持しています。")).toHaveCount(0);
});

test("a correction resets the presented review and a saved draft never double-saves",async({page})=>{
 let parses=0,saves=0;
 await page.route("**/api/voice-recipe",route=>{parses++;return route.fulfill({json:draft});});
 await page.route("**/api/recipes/full",async route=>{
  saves++;const body=route.request().postDataJSON();
  await route.fulfill({status:201,json:{id:body.request_id,title:{value:body.title},revision:0,materials:[],selling_price_jpy:{value:null}}});
 });
 await page.goto("/");
 await input(page,"アマトリチャーナ。乾燥パスタ100g、500g350円");
 await input(page,"内容を確認");
 await expect(page.getByRole("button",{name:"承認して保存",exact:true})).toBeEnabled();
 // A correction reparses and presents the updated draft; nothing was saved.
 await input(page,"トマト200gを追加");
 await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("アマトリチャーナ");
 expect(parses).toBe(2);
 await input(page,"内容を確認");
 await expect(page.getByRole("button",{name:"承認して保存",exact:true})).toBeEnabled();
 expect(saves).toBe(0);
 await input(page,"保存してください");
 await expect(page.getByRole("region", {name: "レシピ詳細"})).toBeVisible();
 expect(saves).toBe(1);
 await page.getByRole("button",{name:"← ホーム",exact:true}).click();
 await input(page,"保存してください");
 await page.waitForTimeout(500);
 expect(saves).toBe(1);
});
