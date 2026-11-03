import {test,expect} from "@playwright/test";

const items=[
 {id:"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",name:"バター",current_price:null},
 {id:"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",name:"牛乳",current_price:{amount_jpy:{value:"320"},per_quantity:"1",per_unit:"L"}},
 {id:"cccccccc-cccc-cccc-cccc-cccccccccccc",name:"小麦粉",current_price:{amount_jpy:{value:"240"},per_quantity:"1",per_unit:"kg"}},
];
async function mockIngredients(page:import("@playwright/test").Page){
 await page.route("**/api/ingredients",async route=>route.fulfill({json:{
  items,suppliers_by_ingredient:{
   "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb":["A食品"],
   "cccccccc-cccc-cccc-cccc-cccccccccccc":["B商事"],
  },
 }}));
}

test("desktop settings keeps Chef brand and displays labeled ingredient table, filtering and sorting",async({page})=>{
 await mockIngredients(page);
 await page.goto("/settings");
 await expect(page.locator("img[src='/chef-ai-mark.svg']")).toBeVisible();
 await expect(page.getByRole("navigation",{name:"設定項目"})).toBeVisible();
 const table=page.getByRole("table");
 await expect(table).toBeVisible();
 await expect(table.getByRole("columnheader",{name:/仕入れ先/})).toBeVisible();
 await expect(table.getByRole("row",{name:/牛乳/})).toContainText("A食品");
 await expect(table.getByRole("row",{name:/バター/})).toContainText("仕入れ先未設定");
 await page.getByLabel("食材名で検索").fill("牛乳");
 await expect(table.locator("tbody tr")).toHaveCount(1);
 await page.getByLabel("食材名で検索").fill("");
 await page.getByLabel("仕入れ先",{exact:true}).selectOption("B商事");
 await expect(table.locator("tbody tr")).toHaveCount(1);
 await expect(table.getByRole("row",{name:/小麦粉/})).toBeVisible();
 await page.getByLabel("仕入れ先",{exact:true}).selectOption("all");
 await table.getByRole("button",{name:/価格・規格/}).click();
 await expect(table.locator("tbody tr").first()).toContainText("バター");
});

test("mobile settings uses one selector and readable ingredient cards",async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await mockIngredients(page);
 await page.goto("/settings");
 await expect(page.locator(".settings-sidebar")).toBeHidden();
 await expect(page.getByLabel("設定項目")).toBeVisible();
 await expect(page.locator(".ingredient-table-wrap")).toBeHidden();
 const cards=page.locator(".ingredient-item-card");
 await expect(cards).toHaveCount(3);
 await expect(cards.filter({hasText:"牛乳"})).toContainText("A食品");
 await page.getByLabel("設定項目").selectOption("plate");
 await expect(page.getByRole("heading",{name:"盛り付け用の皿"})).toBeVisible();
});
