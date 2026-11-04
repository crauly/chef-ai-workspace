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
 await page.getByRole("button",{name:"承認して保存",exact:true}).click();
 await expect(page.getByRole("region", {name: "レシピ詳細"})).toBeVisible();
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
 await page.getByRole("navigation",{name:"設定項目"}).getByRole("button",{name:"単位管理"}).click();
 await expect(page.getByRole("region",{name:"単位マスター"})).toBeVisible();
 await page.getByRole("button",{name:"束を編集"}).click();
 await page.getByLabel("正式単位名").fill("把");
 await page.getByLabel("単位の分類").selectOption("count");
 await page.getByLabel("別名（カンマ区切り）").fill("束");
 await page.getByRole("button",{name:"変更を保存"}).click();
 await expect.poll(()=>saved).toEqual({symbol:"把",dimension:"count",base_factor:null,aliases:["束"]});
});

test("unit creation is separated from record editing",async({page})=>{
 const units=[{id:"unit-a",symbol:"g",dimension:"mass",base_factor:null,aliases:[]}];
 const writes:{method:string;body:any}[]=[];
 await page.route("**/api/units",async route=>{
  if(route.request().method()==="POST"){
   const body=route.request().postDataJSON();writes.push({method:"POST",body});
   units.push({id:"unit-b",symbol:body.symbol,dimension:body.dimension,base_factor:null,aliases:[]});
   return route.fulfill({status:201,json:units.at(-1)});
  }
  return route.fulfill({json:{items:units}});
 });
 await page.goto("/settings?section=unit");
 const create=page.getByRole("region",{name:"新しい単位を登録"});
 await expect(create).toBeVisible();
 const list=page.getByRole("region",{name:"登録済みの単位"});
 await expect(list).toContainText("g");
 const creationPosition=await create.evaluate(el=>el.getBoundingClientRect().top);
 const listPosition=await list.evaluate(el=>el.getBoundingClientRect().top);
 expect(creationPosition).toBeLessThan(listPosition);
 await create.getByRole("textbox",{name:"単位名"}).fill("束");
 await create.getByRole("button",{name:"登録する"}).click();
 await expect(list).toContainText("束");
 expect(writes).toEqual([{method:"POST",body:{symbol:"束",dimension:"other"}}]);
});
