import {test,expect} from "@playwright/test";

const IMG="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

test.beforeEach(async ({request}) => {
 await request.post("http://127.0.0.1:8100/test/reset");
});

test("generated image appears in recipe list on the same origin, survives reload, and other recipes retain placeholder", async ({page}) => {
 await page.route("**/api/dish-image",route=>route.fulfill({json:{image:IMG,mode:"generate"}}));
 let stored=false;
 await page.route("**/api/recipe-images/*",async route=>{
  if(route.request().method()==="POST"){stored=true;return route.fulfill({json:{saved:true}});}
  return stored?route.fulfill({json:{image:IMG}}):route.fulfill({status:404,json:{error:"Not found"}});
 });
 await page.goto("/");
 const named="片栗粉のレシピ";
 const recipe=page.getByRole("button",{name:`${named}の詳細を開く`});
 await expect(recipe.locator(".recipe-list-thumbnail img")).toHaveCount(0);
 await expect(recipe.locator(".recipe-list-thumbnail svg")).toHaveCount(1);
 await expect(recipe.locator(".recipe-list-thumbnail")).not.toContainText("♨");
 await recipe.click();
 const detail=page.getByRole("region",{name:"料理イメージ"});
 await detail.getByRole("button",{name:"✦ 料理画像を生成"}).click();
 await expect(detail.getByText("クラウドに保存済み · 他端末でも表示できます")).toBeVisible();
 await page.getByRole("button",{name:"← ホーム"}).click();
 await expect(page.getByRole("button",{name:`${named}の詳細を開く`}).locator(".recipe-list-thumbnail img")).toHaveAttribute("src",IMG);
 await expect(page.getByRole("button",{name:"ミートソースパスタの詳細を開く"}).locator(".recipe-list-thumbnail img")).toHaveCount(0);
 await expect(page.getByRole("button",{name:"ミートソースパスタの詳細を開く"}).locator(".recipe-list-thumbnail svg")).toHaveCount(1);
 await page.reload();
 await expect(page.getByRole("button",{name:`${named}の詳細を開く`}).locator(".recipe-list-thumbnail img")).toHaveAttribute("src",IMG);
});


test("cloud thumbnail follows the recipe to an independent mobile browser",async ({browser})=>{
 const images=new Map<string,string>();
 const desktop=await browser.newContext({viewport:{width:1280,height:800}});
 const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
 try{
  for(const context of [desktop,mobile]){
   await context.route("**/api/recipe-images/*",route=>{
    const id=new URL(route.request().url()).pathname.split("/").pop()!;
    if(route.request().method()==="POST"){
     images.set(id,(route.request().postDataJSON() as {image:string}).image);
     return route.fulfill({json:{saved:true}});
    }
    const img=images.get(id);
    return img?route.fulfill({json:{image:img}}):route.fulfill({status:404,json:{error:"Not found"}});
   });
  }
  const pc=await desktop.newPage();
  await pc.route("**/api/dish-image",route=>route.fulfill({json:{image:IMG}}));
  await pc.goto("/");
  await pc.getByRole("button",{name:"片栗粉のレシピの詳細を開く"}).click();
  await pc.getByRole("region",{name:"料理イメージ"}).getByRole("button",{name:"✦ 料理画像を生成"}).click();
  await expect(pc.getByRole("region",{name:"料理イメージ"}).getByText("クラウドに保存済み · 他端末でも表示できます")).toBeVisible();
  const phone=await mobile.newPage();
  await phone.goto("/");
  await expect(phone.getByRole("button",{name:"片栗粉のレシピの詳細を開く"}).locator(".recipe-list-thumbnail img")).toHaveAttribute("src",IMG);
 }finally{await desktop.close();await mobile.close();}
});
