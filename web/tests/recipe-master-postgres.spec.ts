import {test,expect} from '@playwright/test';
test.skip(!process.env.CHEF_TEST_PGPORT,'requires disposable local PostgreSQL');
test('voice draft → master choices → approved save → master search → supplier price edit → shared cost → unpriced addition',async({page,request})=>{
 const seeded=await (await request.post('http://127.0.0.1:8103/test/seed-recipe-master')).json();
 const draft={title:'カルボナーラ',materials:[
  {name:'自家製グアンチャーレ',quantity:'30',unit:'g',price_jpy:'',price_quantity:'',price_unit:'',supplier:''},
  {name:'ペコリーノ・ロマーノ',quantity:'30',unit:'g',price_jpy:'6000',price_quantity:'1',price_unit:'kg',supplier:'Amazon'},
  {name:'乾燥パスタ 1.9ミリ ディチェコ',quantity:'100',unit:'g',price_jpy:'350',price_quantity:'500',price_unit:'g',supplier:'Amazon'},
  {name:'鶏卵',quantity:'2',unit:'個',price_jpy:'',price_quantity:'',price_unit:'',supplier:''}],selling_price_jpy:'1800',notes:[],missing:['自家製グアンチャーレの仕入単価','鶏卵の仕入単価']};
 await page.route('**/api/voice-recipe',route=>route.fulfill({json:draft}));
 await page.goto('/');await page.getByLabel('音声認識できない場合の入力').fill('カルボナーラ。自家製グアンチャーレ30g、ペコリーノロマーノ30g、乾燥パスタ1.9ミリ ディチェコ100g、鶏卵2個。');await page.getByRole('button',{name:'反映',exact:true}).click();
 await expect(page.getByText('未保存の下書き：カルボナーラ')).toBeVisible();await page.getByRole('button',{name:'レシピを登録',exact:true}).click();
 const matching=page.getByRole('region',{name:'食材マスターの照合'});await expect(matching).toContainText('食材 4件');await expect(page.getByRole('button',{name:'承認して保存',exact:true})).toBeDisabled();
 await matching.getByLabel('ペコリーノ・ロマーノの食材マスター').selectOption(seeded.pecorino);await matching.getByRole('listitem').filter({hasText:'ペコリーノ・ロマーノ'}).getByRole('button',{name:'選択して再照合'}).click();
 await matching.getByLabel('乾燥パスタ 1.9ミリ ディチェコの食材マスター').selectOption('new');await matching.getByLabel('新規食材の規格').fill('500g袋');await matching.getByRole('listitem').filter({hasText:'乾燥パスタ 1.9ミリ ディチェコ'}).getByRole('button',{name:'選択して再照合'}).click();
 await expect(matching).toContainText('既存マスターを再利用');await page.getByRole('button',{name:'承認して保存',exact:true}).click();await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]+$/);
 const recipePath=new URL(page.url()).pathname;const saved=await (await request.get('/api'+recipePath)).json();expect(saved.materials).toHaveLength(4);expect(saved.materials[1].ingredient_id).toBe(seeded.pecorino);
 const pasta=saved.materials[2],guanciale=saved.materials[0];
 await page.goto('/settings?section=ingredient');await expect(page.getByRole('heading',{name:'食材マスター',exact:true})).toBeVisible();await page.getByRole('searchbox',{name:'食材名と規格で検索'}).fill('グアンチャーレ');await expect(page.getByRole('row',{name:/自家製グアンチャーレ/})).toBeVisible();
 await page.getByRole('searchbox',{name:'食材名と規格で検索'}).fill('鶏卵');await expect(page.getByRole('row',{name:/鶏卵/})).toBeVisible();
 // A second recipe deliberately reuses the same exact master and purchase terms.
 const peerBody={request_id:crypto.randomUUID(),title:'同条件の別レシピ',materials:[{ingredient_id:pasta.ingredient_id,name:pasta.material_name.value,quantity:'100',unit:'g',supplier:'Amazon'}]};
 const peer=await (await request.post('/api/recipes/full',{data:peerBody,headers:{Origin:'http://localhost:3103'}})).json();expect(peer.id).toBeTruthy();
 await page.goto(recipePath);await page.getByRole('button',{name:pasta.material_name.value+'を編集',exact:true}).click();let dialog=page.getByRole('dialog');
 await expect(dialog.getByLabel('仕入単価（円）')).toBeEnabled();await dialog.getByLabel('仕入単価（円）').fill('400');await dialog.getByLabel('数量',{exact:true}).fill('120');await dialog.getByRole('button',{name:'変更して保存',exact:true}).click();
 dialog=page.getByRole('dialog',{name:'レシピと食材マスターの保存確認'});await expect(dialog).toContainText('Amazon：¥400 / 500 g');await dialog.getByRole('button',{name:'承認して保存'}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 const updated=await (await request.get('/api'+recipePath)).json();expect(updated.materials[2].quantity.value).toBe('120');expect(updated.materials[2].effective_price.amount_jpy.value).toBe('400');
 const peerCost=await (await request.get('/api/recipes/'+peer.id+'/cost')).json();expect(peerCost.total_cost_jpy).toBe('80');
 await page.reload();await expect(page.locator('.ingredient-row').filter({hasText:pasta.material_name.value})).toContainText('¥400 / 500g');
 await page.getByText('＋ 食材を追加',{exact:true}).click();const add=page.locator('form.material-form');await add.getByLabel('食材名',{exact:true}).fill('黒胡椒');await add.getByLabel('数量',{exact:true}).fill('1');await add.getByLabel('Unit',{exact:true}).selectOption('g');await expect(add.getByRole('button',{name:'食材を追加',exact:true})).toBeEnabled();await add.getByRole('button',{name:'食材を追加',exact:true}).click();
 await page.getByRole('dialog').getByRole('button',{name:'承認して保存'}).click();await expect(page.getByRole('button',{name:'黒胡椒を編集',exact:true})).toBeVisible();
 const final=await (await request.get('/api'+recipePath)).json();expect(final.materials).toHaveLength(5);expect(final.materials[4].effective_price).toBeNull();expect(final.materials[0].ingredient_id).toBe(guanciale.ingredient_id);
});
