import {test,expect} from "@playwright/test";

test("unknown units are visible in review and registered only on explicit recipe approval",async({page})=>{
 let writes=0; let approved:any=null;
 await page.route("**/api/units",async route=>route.fulfill({status:200,contentType:"application/json",
  body:JSON.stringify({items:[{id:"owned-id",symbol:"g",dimension:"mass",aliases:["グラム"]}]})}));
 await page.route("**/api/voice-recipe",async route=>route.fulfill({status:200,contentType:"application/json",
  body:JSON.stringify({title:"野菜のソテー",materials:[{name:"青菜",quantity:"2",unit:"束",
   price_jpy:"300",price_quantity:"1",price_unit:"束",supplier:""}],
   selling_price_jpy:"1200",unitProposals:[{symbol:"束",dimension:"count"}],notes:[],missing:[],interpretations:[],price_research:[],name_corrections:[]})}));
 await page.route("**/api/recipes/full",async route=>{
  writes++;approved=route.request().postDataJSON();
  await route.fulfill({status:201,contentType:"application/json",body:JSON.stringify({
   id:approved.request_id,title:{value:approved.title,status:"confirmed"},
   materials:[],revision:0,selling_price_jpy:{value:"1200",status:"confirmed"}})});
 });
 await page.goto("/");
 const entry=page.getByLabel("音声認識できない場合の入力");
 await entry.fill("野菜のソテー、青菜2束、1束300円、売価1200円");
 await page.getByRole("button",{name:"反映"}).click();
 await expect(page.getByRole("group",{name:"保存時に作成する単位マスター"})).toBeVisible();
 await expect(page.getByLabel("束の単位分類")).toHaveValue("count");
 expect(writes).toBe(0);
 await page.getByRole("button",{name:"レシピを登録"}).click();
 await expect(page.getByText("レシピを保存しました。")).toBeVisible();
 expect(writes).toBe(1);
 expect(approved.unit_candidates).toEqual([{symbol:"束",dimension:"count"}]);
});

test("unit master settings edit canonical name, dimension and aliases",async({page})=>{
 const catalog=[{id:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",symbol:"束",dimension:"other",aliases:[]}];
 let saved:any=null;
 await page.route("**/api/units",async route=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({items:catalog})}));
 await page.route("**/api/units/*",async route=>{
  saved=route.request().postDataJSON();await route.fulfill({status:200,contentType:"application/json",body:JSON.stringify({ok:true})});
 });
 await page.goto("/settings");
 await page.locator("details").filter({has:page.locator("summary", {hasText:"単位マスター"})}).locator("summary").click();
 await expect(page.getByRole("region",{name:"単位マスター"})).toBeVisible();
 await page.getByRole("button",{name:"単位を編集"}).click();
 await page.getByLabel("正式単位名").fill("把");
 await page.getByLabel("単位の分類").selectOption("count");
 await page.getByLabel("別名（カンマ区切り）").fill("束");
 await page.getByRole("button",{name:"保存"}).click();
 await expect.poll(()=>saved).toEqual({symbol:"把",dimension:"count",base_factor:null,aliases:["束"]});
});
