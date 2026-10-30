import {test,expect,type Page} from "@playwright/test";

const draft={title:"アマトリチャーナ",materials:[
 {name:"乾燥パスタ",quantity:"100",unit:"g",price_jpy:"350",price_quantity:"500",price_unit:"g"},
 {name:"トマト",quantity:"200",unit:"g",price_jpy:"300",price_quantity:"1",price_unit:"kg"},
],selling_price_jpy:"",notes:[],missing:[],interpretations:[]};
async function input(page:Page,text:string){
 await page.getByLabel("音声認識できない場合の入力").fill(text);
 await page.getByRole("button",{name:"反映",exact:true}).click();
}
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
 await page.getByRole("button",{name:"レシピを参照",exact:true}).click();
 await expect(page.getByText("登録途中の下書きを保持しています。")).toBeVisible();
 // Review from browse must return to the pending draft, not start a new search.
 await input(page,"内容を確認");
 await expect(page.getByLabel("未保存のレシピ下書き")).toBeVisible();
 expect(parses).toBe(1);
 await expect(page.getByText("登録途中の下書きを保持しています。")).toHaveCount(0);
 // The routed review presents the draft for approval without a new Muse parse.
 await expect(page.getByText("確認待ち")).toBeVisible();
 expect(parses).toBe(1);
 // An explicit save after the presented review commits through the normal gate.
 await input(page,"保存してください");
 await expect(page.getByText("レシピを保存しました。")).toBeVisible();
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
 await expect(page.getByText("料理の解釈に失敗しました。")).toBeVisible();
 await input(page,"トマト200g、1kg300円");
 await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("アマトリチャーナ");
});

test("return-to-draft respects a pending edit proposal instead of discarding it",async({page})=>{
 await page.route("**/api/voice-recipe",route=>route.fulfill({json:starchDraft}));
 await page.goto("/");
 await input(page,"片栗粉10g、1kg1000円");
 await expect(page.getByLabel("未保存のレシピ下書き")).toBeVisible();
 await page.getByRole("button",{name:"レシピを参照",exact:true}).click();
 await expect(page.getByText("登録途中の下書きを保持しています。")).toBeVisible();
 await input(page,"片栗粉のレシピを見せて");
 await expect(page.getByRole("region",{name:"Recipe cost summary"})).toBeVisible();
 await input(page,"片栗粉を15gに変更");
 await expect(page.getByLabel("提案の差分")).toBeVisible();
 await page.getByRole("button",{name:"下書きに戻る",exact:true}).click();
 await expect(page.getByRole("region",{name:"音声操作モード"})).toContainText("未保存の変更案があります");
 await expect(page.getByRole("region",{name:"音声操作モード"})).toContainText("現在のモード: 編集");
 await expect(page.getByLabel("提案の差分")).toBeVisible();
});

test("explicit cancel clears the draft while plain transitions keep it",async({page})=>{
 let parses=0;
 await page.route("**/api/voice-recipe",route=>{parses++;return route.fulfill({json:draft});});
 await page.goto("/");
 await input(page,"アマトリチャーナ。乾燥パスタ100g、500g350円");
 await expect(page.getByLabel("未保存のレシピ下書き")).toBeVisible();
 await page.getByRole("button",{name:"レシピを参照",exact:true}).click();
 await expect(page.getByText("登録途中の下書きを保持しています。")).toBeVisible();
 await page.getByRole("button",{name:"新規登録・下書きを再開",exact:true}).click();
 await expect(page.getByLabel("未保存のレシピ下書き")).toBeVisible();
 expect(parses).toBe(1);
 await input(page,"キャンセル");
 await expect(page.getByLabel("未保存のレシピ下書き")).toHaveCount(0);
 await page.getByRole("button",{name:"レシピを参照",exact:true}).click();
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
 await expect(page.getByRole("button",{name:"内容を承認して保存",exact:true})).toBeEnabled();
 await input(page,"トマト200gを追加");
 await expect(page.getByRole("button",{name:"内容を承認して保存",exact:true})).toBeDisabled();
 expect(parses).toBe(2);
 await input(page,"内容を確認");
 await expect(page.getByText("確認待ち")).toBeVisible();
 await input(page,"保存してください");
 await expect(page.getByText("レシピを保存しました。")).toBeVisible();
 expect(saves).toBe(1);
 await input(page,"保存してください");
 await page.waitForTimeout(500);
 expect(saves).toBe(1);
});
