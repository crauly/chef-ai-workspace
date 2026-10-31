import {test,expect} from "@playwright/test";
test("full recipe voice dialogue requires review before one atomic save",async({page})=>{
 let saved=0;
 const draft={title:"カルボナーラ",materials:[{name:"卵",quantity:"100",unit:"g",price_jpy:"60",price_quantity:"50",price_unit:"g"}],selling_price_jpy:"1800",notes:[],missing:[]};
 await page.route("**/api/voice-recipe",async route=>{
  const body=route.request().postDataJSON();
  expect(body.turns.length).toBeGreaterThan(0);
  await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(draft)});
 });
 await page.route("**/api/recipes/full",async route=>{
  saved++;
  const body=route.request().postDataJSON();
  expect(body.title).toBe("カルボナーラ");
  expect(body.materials).toHaveLength(1);
  expect(body.selling_price_jpy).toBe("1800");
  expect(body.request_id).toMatch(/^[0-9a-f-]{36}$/);
  const recipe={id:body.request_id,title:{value:body.title,status:"confirmed"},revision:0,materials:[],selling_price_jpy:{value:body.selling_price_jpy,status:"confirmed"}};
  await route.fulfill({status:201,contentType:"application/json",body:JSON.stringify(recipe)});
 });
 await page.goto("/");
 const entry=page.getByLabel("音声認識できない場合の入力");
 await entry.fill("カルボナーラ、卵100グラム、卵は50グラム60円、売価1800円");
 await page.getByRole("button",{name:"反映"}).click();
 await expect(page.getByText("未保存の下書き：カルボナーラ")).toBeVisible();
 await expect(page.getByText("卵: 100g ／ 仕入単価 ¥60 / 50g")).toBeVisible();
 await expect(page.getByRole("button",{name:"内容を承認して保存"})).toBeDisabled();
 expect(saved).toBe(0);
 await entry.fill("登録を確定");await page.getByRole("button",{name:"反映"}).click();
 await expect(page.getByText(/^確認用の下書きを表示しました。/)).toBeVisible();
 expect(saved).toBe(0);
 await entry.fill("内容 を 確認");await page.getByRole("button",{name:"反映"}).click();
 await expect(page.getByRole("button",{name:"内容を承認して保存"})).toBeEnabled();
 expect(saved).toBe(0);
 await entry.fill("登録 を 確定");await page.getByRole("button",{name:"反映"}).click();
 await expect(page.getByText("レシピを保存しました。")).toBeVisible();
 expect(saved).toBe(1);
});
