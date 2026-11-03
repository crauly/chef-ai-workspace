import {test,expect} from "@playwright/test";

const A="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa10";
const B="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb00b1";
const C="cccccccc-cccc-cccc-cccc-cccccccc00c2";

function m7(id:string,name:string){
 return {ingredient_id:id,ingredient_name:name,candidates:[],total_found:0,returned:0,shortage_note:null,provider:{available:false,reason:"no web retrieval"}};
}
function axisCandidate(name:string,supplier:string){
 return {kind:"same_product_other_supplier",ingredient_id:B,ingredient_name:name,offer_id:"offer-"+supplier,supplier_name:supplier,product_url:null,amount:"400",currency:"JPY",package_quantity:"500",package_unit:"g",shipping_note:"送料込",tax_note:"税込",source:"purchase",observed_at:"2026-10-21T10:00:00+00:00",data_origin:"ledger",unknowns:[],comparison:{comparable:false,reasons:["税条件不一致"],currency:"JPY",unit_basis:null,diff:null,rate_pct:null}};
}
function axisBody(){
 const picks=[
  {axis:"cost",candidate_index:0,candidate:axisCandidate("問屋Bパスタ","問屋B"),reason:"比較可能条件での最安単位価格",reason_source:"deterministic",confidence:null},
  {axis:"cost",candidate_index:1,candidate:axisCandidate("問屋Cパスタ","問屋C"),reason:"比較可能条件の次点単位価格（同種商品の予備候補）",reason_source:"deterministic",confidence:null},
  {axis:"cost",candidate_index:2,candidate:axisCandidate("問屋Dパスタ","問屋D"),reason:"比較可能条件の次点単位価格（同種商品の予備候補）",reason_source:"deterministic",confidence:null},
 ];
 return {ingredient_id:B,ingredient_name:"食材B",
  axes:{cost:{pick:picks[0],label:"コスト重視"},
   compatibility:{pick:null,label:"互換性・類似性重視",empty_reason:"Muse評価が未実行のため選定なし"},
   quality:{pick:null,label:"品質・評価重視",empty_reason:"Muse評価が未実行のため選定なし"}},
  picks,returned:3,shortage_note:null,
  provider:{external:{available:false,reason:"no web retrieval"},muse:{used:false,evaluated:0,skipped:0,error:"not configured"}}};
}

test("axis picks show every returned candidate and never mix ingredients",async({page})=>{
 const requested:string[]=[];
 let releaseA!:()=>void;
 const blockedA=new Promise<void>(resolve=>{releaseA=resolve;});
 await page.route("**/api/sourcing-suggestions?**",route=>{
  const id=new URL(route.request().url()).searchParams.get("ingredient_id");
  return route.fulfill({json:id===A?m7(A,"食材A"):m7(B,"食材B")});
 });
 await page.route("**/api/axis-suggestions?**",async route=>{
  const id=new URL(route.request().url()).searchParams.get("ingredient_id");
  requested.push(id||"");
  if(id===A){await blockedA;return route.fulfill({json:{...axisBody(),ingredient_id:A,ingredient_name:"食材A"}});}
  return route.fulfill({json:axisBody()});
 });
 await page.goto("/settings");
 await page.locator("details").filter({has:page.locator("summary", {hasText:"購入先候補"})}).locator("summary").click();
 // Load A's candidates, then start its (blocked) axis request.
 await page.getByLabel("食材ID").fill(A);
 await page.getByRole("button",{name:"候補を探す",exact:true}).click();
 await expect(page.getByText("食材A —")).toBeVisible();
 await page.getByRole("button",{name:"3軸で比べる",exact:false}).click();
 // Retarget to B while A's axis request is in flight.
 await page.getByLabel("食材ID").fill(B);
 await page.getByRole("button",{name:"候補を探す",exact:true}).click();
 await expect(page.getByText("食材B —")).toBeVisible();
 // Type another ID without searching: the axis request must still use B.
 await page.getByLabel("食材ID").fill(C);
 await page.getByRole("button",{name:"3軸で比べる",exact:false}).click();
 await expect(page.getByText("軸別選定 (食材B)")).toBeVisible();
 // Every returned pick is displayed: 1 cost slot + 2 backups.
 await expect(page.getByText("問屋Bパスタ")).toBeVisible();
 await expect(page.getByText("その他の候補")).toBeVisible();
 await expect(page.getByText("問屋Cパスタ")).toBeVisible();
 await expect(page.getByText("問屋Dパスタ")).toBeVisible();
 await expect(page.getByText("Muse評価なし",{exact:false})).toBeVisible();
 expect(requested).toContain(A);
 expect(requested).toContain(B);
 expect(requested).not.toContain(C);
 // A's late response must not overwrite B's displayed picks.
 releaseA();
 await page.waitForTimeout(300);
 await expect(page.getByText("軸別選定 (食材B)")).toBeVisible();
 await expect(page.getByText("軸別選定 (食材A)")).toHaveCount(0);
});
