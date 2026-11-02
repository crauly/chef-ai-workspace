import {test,expect} from "@playwright/test";
const IMG="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test.beforeEach(async ({request})=>{await request.post("http://127.0.0.1:8100/test/reset");});

test("approved voice draft carries its generated preview to the saved recipe without another model call",async({page})=>{
 let images=0,saves=0,recipeId="";
 await page.route("**/api/dish-image",route=>{images++;return route.fulfill({json:{image:IMG}});});
 await page.route("**/api/voice-recipe",route=>route.fulfill({json:{
  title:"鴨胸肉のロティ",materials:[{name:"鴨胸肉",quantity:"180",unit:"g",price_jpy:"3400",price_quantity:"1",price_unit:"kg"}],
  selling_price_jpy:"3800",notes:[],missing:[]
 }}));
 await page.route("**/api/recipes/full",async route=>{
  saves++;const body=route.request().postDataJSON();recipeId=body.request_id;
  await route.fulfill({status:201,json:{id:recipeId,title:{value:body.title,status:"confirmed"},materials:[],revision:0,selling_price_jpy:{value:"3800",status:"confirmed"}}});
 });
 await page.goto("/");
 const entry=page.getByLabel("音声認識できない場合の入力");
 await entry.fill("鴨胸肉のロティ、180グラム、1キロ3400円、売価3800円");
 await page.getByRole("button",{name:"反映"}).click();
 await expect(page.getByText("未保存の下書き：鴨胸肉のロティ")).toBeVisible();
 await page.getByRole("button",{name:/料理画像を生成/}).click();
 await page.getByRole("dialog",{name:"料理イメージを生成"}).getByRole("button",{name:/画像を生成/}).click();
 await expect(page.getByRole("img",{name:"生成した料理イメージ"})).toBeVisible();
 await entry.fill("内容を確認");await page.getByRole("button",{name:"反映"}).click();
 await expect(page.getByRole("button",{name:"内容を承認して保存"})).toBeEnabled();
 expect(saves).toBe(0);
 await entry.fill("保存してください");await page.getByRole("button",{name:"反映"}).click();
 await expect.poll(()=>saves).toBe(1);
 await expect.poll(async()=>page.evaluate(async(id)=>{
  return await new Promise<boolean>((resolve,reject)=>{
   const req=indexedDB.open("chef-ai-recipe-image-cache",1);
   req.onerror=()=>reject(req.error);
   req.onsuccess=()=>{const db=req.result;const get=db.transaction("images","readonly").objectStore("images").get(id);
    get.onsuccess=()=>{resolve(get.result===IMG);db.close();};get.onerror=()=>reject(get.error);};
  });
 },recipeId)).toBe(true);
 expect(images).toBe(1);
});
