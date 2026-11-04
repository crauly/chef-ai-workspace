import {test,expect} from '@playwright/test';
for(const width of [1280,390])test(`master selection is reviewed before saving at ${width}px`,async({page,request})=>{
 await request.post('http://127.0.0.1:8100/test/reset');await page.setViewportSize({width,height:844});
 const ingredient='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';let reviews=0;
 await page.route('**/api/recipes/*/confirm/review',async route=>{
  const body=route.request().postDataJSON();reviews++;
  if(reviews>1){expect(body.operations).toContainEqual(expect.objectContaining({op:'link_ingredient',ingredient_id:ingredient}));expect(body.ledger[0]).toMatchObject({kind:'reuse',id:ingredient});}
  await route.fulfill({json:{ingredients:[{material_id:'22222222-2222-4222-8222-222222222222',name:'片栗粉',action:reviews===1?'choose':'reuse',candidates:[{id:ingredient,name:'片栗粉',spec:'大きな業務用袋の購入条件・メーカーの異なる商品です'.repeat(3)}]}],materials:[],purchases:[],requires_selection:reviews===1}});
 });
 await page.goto('/recipes/11111111-1111-4111-8111-111111111111');await page.getByRole('button',{name:'片栗粉を編集',exact:true}).click();const edit=page.getByRole('dialog');await edit.getByLabel('数量',{exact:true}).fill('15');await edit.getByRole('button',{name:'変更して保存'}).click();
 const review=page.getByRole('dialog',{name:'レシピと食材マスターの保存確認'});await expect(review.getByRole('button',{name:'承認して保存'})).toBeDisabled();
 await review.getByLabel('片栗粉の食材マスター').selectOption(ingredient);const bounds=await review.boundingBox();expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(width);
 await review.getByRole('button',{name:'選択して再照合'}).click();await expect(review.getByRole('button',{name:'承認して保存'})).toBeEnabled();expect((await (await request.get('http://127.0.0.1:8100/test/state')).json()).confirms).toHaveLength(0);
});
test('unavailable unit catalog explains why unpriced addition is disabled',async({page,request})=>{
 await request.post('http://127.0.0.1:8100/test/reset');await page.route('**/api/units',route=>route.fulfill({status:503,json:{error:'unavailable'}}));await page.goto('/recipes/11111111-1111-4111-8111-111111111111');
 await page.getByText('＋ 食材を追加',{exact:true}).click();const form=page.locator('form.material-form');await form.getByLabel('食材名',{exact:true}).fill('鶏卵');await form.getByLabel('数量',{exact:true}).fill('2');await expect(form.getByRole('status')).toContainText('単位マスターの取得に失敗');await expect(form.getByRole('button',{name:'食材を追加',exact:true})).toBeDisabled();
});
