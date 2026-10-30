import {test,expect} from "@playwright/test";
test("voice recipe with unknown prices saves explicitly as price-unconfirmed",async({page})=>{
 let saved=0;let body:any=null;
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
  const recipe={id:body.request_id,title:{value:body.title,status:"confirmed"},revision:0,materials:[],selling_price_jpy:{value:body.selling_price_jpy,status:"confirmed"}};
  await route.fulfill({status:201,contentType:"application/json",body:JSON.stringify(recipe)});
 });
 await page.goto("/");
 const entry=page.getByLabel("音声認識できない場合の入力");
 await entry.fill("カルボナーラ、卵100グラム、値段はわかりません");
 await page.getByRole("button",{name:"反映"}).click();
 await expect(page.getByText("未保存の下書き：カルボナーラ")).toBeVisible();
 await expect(page.getByText("仕入単価 未確定（推測しません）")).toBeVisible();
 await expect(page.getByRole("button",{name:"内容を承認して保存"})).toBeDisabled();
 expect(saved).toBe(0);
 // A single save request only opens review, never saves (Human Gate).
 await entry.fill("保存してください");await page.getByRole("button",{name:"反映"}).click();
 await expect(page.getByText(/仕入単価が不明の項目があります/)).toBeVisible();
 await expect(page.getByRole("button",{name:"価格未確定として承認して保存"})).toBeEnabled();
 expect(saved).toBe(0);
 // The second explicit approval saves with prices omitted, not zero-filled.
 await entry.fill("保存してください");await page.getByRole("button",{name:"反映"}).click();
 await expect(page.getByRole("region",{name:"音声操作モード"}).getByText("価格未確定として保存しました。未確定の仕入単価はゼロにせず、部分原価のみ表示されます。")).toBeVisible();
 expect(saved).toBe(1);
});
