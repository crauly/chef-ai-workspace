import {test,expect,type Page} from '@playwright/test';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',amazon='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',other='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
async function setup(page:Page,priced=true,originalUnit='g'){
 const state={item:{id,name:'パスタ',spec:'500g袋',current_price:null,price_research_enabled:false},quotes:priced?[{offer_id:'old',supplier_id:amazon,supplier_name:'Amazon',amount_jpy:'350',quantity:'500',unit:originalUnit,observed_at:'2026-11-04T00:00:00Z'}]:[] as any[],calls:[] as any[],failure:''};
 await page.route('**/api/ingredients',route=>route.fulfill({json:{items:[state.item],approved_prices_by_ingredient:{[id]:state.quotes},suppliers_by_ingredient:{[id]:state.quotes.map(q=>q.supplier_name)}}}));
 await page.route('**/api/suppliers?*',route=>route.fulfill({json:{items:[{id:amazon,name:'Amazon'},{id:other,name:'B食品'}]}}));
 await page.route('**/api/units',route=>route.fulfill({json:{items:['g','kg','個','ケース','袋'].map((symbol,i)=>({id:String(i),symbol,aliases:[]}))}}));
 await page.route('**/api/ingredients/*/offer-prices',route=>route.fulfill({json:{items:state.quotes}}));
 await page.route('**/api/offer-prices',()=>{throw new Error('separate adoption API must not be called');});
 await page.route('**/api/ingredients/'+id,async route=>{
  const body=route.request().postDataJSON();state.calls.push(body);
  if(state.failure)return route.fulfill({status:503,json:{error:state.failure,internal:'private database detail'}});
  Object.assign(state.item,{name:body.name,spec:body.spec,price_research_enabled:body.price_research_enabled});
  if(body.purchase){state.quotes.push({offer_id:'new',supplier_id:body.supplier_id,supplier_name:body.supplier_id===other?'B食品':'Amazon',amount_jpy:body.purchase.amount_jpy,quantity:body.purchase.quantity,unit:body.purchase.unit,observed_at:'2026-11-05T00:00:00Z'});}
  await route.fulfill({json:{id,updated:true}});
 });
 await page.goto('/settings?section=ingredient');return state;
}
async function edit(page:Page){await page.locator('.ingredient-table-wrap').waitFor({state:'attached'});if((page.viewportSize()?.width??1280)>650)await page.getByRole('button',{name:'編集',exact:true}).click();else await page.getByRole('button',{name:'パスタを編集',exact:true}).click();const dialog=page.getByRole('dialog');await expect(dialog.getByRole('button',{name:'保存',exact:true})).toBeEnabled();return dialog;}

test('identity/spec/research save is one operation and retains unchanged price without new history',async({page})=>{
 const s=await setup(page);const dialog=await edit(page);await expect(dialog.getByLabel('仕入価格（円）')).toHaveValue('350');
 await expect(dialog.getByRole('button',{name:'保存',exact:true})).toHaveCount(1);await expect(dialog.getByRole('button',{name:'価格を登録・採用'})).toHaveCount(0);
 await dialog.getByLabel('食材名',{exact:true}).fill('乾燥パスタ');await dialog.getByLabel('規格（商品の識別用）').fill('新しい規格');await dialog.getByRole('switch').check();
 await dialog.getByLabel('仕入価格（円）').fill('350.00');await dialog.getByRole('button',{name:'保存',exact:true}).click();
 await expect(page.getByRole('dialog')).toHaveCount(0);expect(s.calls).toHaveLength(1);expect(s.calls[0].purchase).toBeNull();expect(s.quotes).toHaveLength(1);
 await page.reload();const row=page.getByRole('row',{name:/乾燥パスタ/});await expect(row).toContainText('新しい規格');await expect(row).toContainText('定期調査ON');
 await row.getByRole('button',{name:'編集',exact:true}).click();await expect(page.getByRole('dialog').getByLabel('規格（商品の識別用）')).toHaveValue('新しい規格');
});
for(const width of [1280,390])test(`combined name/supplier/quote save is reviewed, atomic and survives reload at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:844});const s=await setup(page);const dialog=await edit(page);
 await dialog.getByLabel('食材名',{exact:true}).fill('変更パスタ');await dialog.getByLabel('仕入れ先（採用価格）').selectOption(other);
 await dialog.getByLabel('仕入価格（円）').fill('1000');await dialog.getByLabel('仕入数量').fill('2');await dialog.getByLabel('仕入単位').selectOption('ケース');
 await expect(dialog.getByLabel('仕入単位').getByRole('option',{name:'袋',exact:true})).toHaveCount(1);
 const bounds=await dialog.boundingBox();expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(width);
 await dialog.getByRole('button',{name:'保存',exact:true}).click();const review=page.getByRole('dialog',{name:'食材と価格の保存確認'});
 await expect(review).toContainText('B食品');await expect(review).toContainText('1000 / 2 ケース');expect(s.calls).toHaveLength(0);
 await review.getByRole('button',{name:'承認して保存'}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 expect(s.calls).toHaveLength(1);expect(s.calls[0]).toMatchObject({name:'変更パスタ',supplier_id:other,purchase:{amount_jpy:'1000',quantity:'2',unit:'ケース'},price_confirmed:true});
 await page.reload();await expect(page.locator(width===390?'.ingredient-item-card':'.ingredient-table tbody tr').first()).toContainText('B食品: ¥1,000 / 2 ケース');
 if(width===390)await page.getByRole('button',{name:'変更パスタを編集',exact:true}).click();else await page.getByRole('row',{name:/変更パスタ/}).getByRole('button',{name:'編集',exact:true}).click();
 const reopened=page.getByRole('dialog');await expect(reopened.getByLabel('仕入価格（円）')).toHaveValue('1000');await expect(reopened.getByLabel('仕入単位')).toHaveValue('ケース');await expect(reopened.locator('.ingredient-supplier-prices')).toContainText('Amazon');await expect(reopened.locator('.ingredient-supplier-prices')).toContainText('B食品');
});
test('an unpriced ingredient remains editable without adopting a price',async({page})=>{const s=await setup(page,false);const d=await edit(page);await d.getByLabel('食材名',{exact:true}).fill('未価格パスタ');await d.getByRole('button',{name:'保存',exact:true}).click();await expect(d).toHaveCount(0);expect(s.calls[0].purchase).toBeNull();expect(s.quotes).toHaveLength(0);});
test('unknown units and invalid quantities show actionable errors before any write',async({page})=>{
 const s=await setup(page,true,'未登録');const d=await edit(page);await d.getByLabel('仕入価格（円）').fill('400');await d.getByRole('button',{name:'保存',exact:true}).click();await expect(d.getByRole('alert')).toContainText('単位マスターに登録されていません');
 await d.getByLabel('仕入単位').selectOption('g');await d.getByLabel('仕入数量').fill('0');await d.getByRole('button',{name:'保存',exact:true}).click();await expect(d.getByRole('alert')).toContainText('仕入数量は0より大きい');expect(s.calls).toHaveLength(0);
});
for(const [code,message] of [['supplier_unavailable','仕入れ先が存在しない'],['ingredient_conflict','競合'],['database_error','データベース'],['api_unavailable','APIとの通信'],['unit_unknown','単位マスターに登録されていません']])test(`save error ${code} retains all inputs and retries the same request id`,async({page})=>{
 const s=await setup(page);s.failure=code;let d=await edit(page);await d.getByLabel('食材名',{exact:true}).fill('保持する名前');await d.getByLabel('仕入価格（円）').fill('400');await d.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('button',{name:'承認して保存'}).click();
 d=page.getByRole('dialog');await expect(d.getByRole('alert')).toContainText(message);await expect(d.getByRole('alert')).not.toContainText('private');await expect(d.getByLabel('食材名',{exact:true})).toHaveValue('保持する名前');await expect(d.getByLabel('仕入価格（円）')).toHaveValue('400');
 s.failure='';await d.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('button',{name:'承認して保存'}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect(s.calls).toHaveLength(2);expect(s.calls[1]).toEqual(s.calls[0]);
});
