import {test,expect} from "@playwright/test";
import {voiceInput} from "./voice-input";

test("approved spoken Amazon purchase survives reload and appears in suppliers with a 70-yen line cost",async({page})=>{
 let saved:any=null,saves=0;
 const supplierId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",offerId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
 const marketId="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
 await page.route("**/api/voice-recipe",route=>{
  expect(route.request().postDataJSON().turns.join(" ")).toContain("Amazon");
  return route.fulfill({json:{title:"Amazonのパスタ",materials:[{name:"パスタ",quantity:"100",unit:"g",price_jpy:"350",price_quantity:"500",price_unit:"g",supplier:"Amazon"}],selling_price_jpy:"1000",notes:[],missing:[]}});
 });
 await page.route("**/api/recipes/full",route=>{
  const body=route.request().postDataJSON();saves++;
  expect(body.materials[0]).toMatchObject({supplier:"Amazon",quantity:"100",price_jpy:"350",price_quantity:"500",price_unit:"g"});
  const tracked=(value:string)=>({value,status:"confirmed",origin:"user"});
  saved={id:body.request_id,title:tracked(body.title),revision:0,selling_price_jpy:tracked("1000"),materials:[{
   id:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",material_name:tracked("パスタ"),quantity:tracked("100"),unit:"g",price_mode:"inherit",price_override:null,
   ingredient_id:"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",supplier_id:supplierId,supplier_name:"Amazon",offer_id:offerId,
   effective_price:{amount_jpy:tracked("350"),per_quantity:"500",per_unit:"g"}}]};
  return route.fulfill({status:201,json:saved});
 });
 await page.route("**/api/recipes/*",route=>saved&&route.request().method()==="GET"&&route.request().url().endsWith(saved.id)?route.fulfill({json:saved}):route.fallback());
 await page.route("**/api/recipes/*/cost",route=>saved?route.fulfill({json:{partial:false,total_cost_jpy:"70",subtotal_jpy:"70",line_costs:{[saved.materials[0].id]:"70"},cost_rate_pct:"7.0",estimated:false,unresolved_line_ids:[]}}):route.fallback());
 await page.route("**/api/suppliers?*",route=>route.fulfill({json:{items:[{id:supplierId,name:"Amazon",note:null},{id:marketId,name:"相場参考価格",note:"平均・参考価格の抽象仕入先",is_market_reference:true}],page:1,page_size:100}}));
 await page.goto("/");
 await voiceInput(page,"パスタ100g、Amazonで500g350円、売価1000円");
 await expect(page.getByLabel("未保存のレシピ下書き")).toContainText("Amazon");expect(saves).toBe(0);
 await voiceInput(page,"内容を確認");expect(saves).toBe(0);
 await voiceInput(page,"保存しないでください");
 await expect(page.getByText("保存せず、下書きを保持します。",{exact:true})).toBeAttached();expect(saves).toBe(0);
 await voiceInput(page,"内容を確認");
 await voiceInput(page,"保存してください");
 const detail=page.locator("section.recipe-detail");
 await expect(detail.getByRole("heading",{name:"Amazonのパスタ"})).toBeVisible();
 await expect(detail.locator(".ingredient-row")).toContainText("Amazon");
 await expect(detail.locator(".ingredient-row")).toContainText(/材料原価.*70/);expect(saves).toBe(1);
 await page.reload();await expect(page.locator(".ingredient-row")).toContainText("Amazon");
 await expect(page.locator(".ingredient-row")).toContainText(/材料原価.*70/);
 await page.goto("/settings?section=supplier");
 await expect(page.locator(".supplier-manager-list")).toContainText("Amazon");
 await expect(page.locator(".supplier-manager-list")).toContainText("相場参考価格");
 await expect(page.locator(".supplier-manager-list li",{hasText:"相場参考価格"}).getByRole("button",{name:"削除"})).toBeDisabled();
});
