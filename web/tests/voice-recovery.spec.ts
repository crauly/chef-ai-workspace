import {test,expect} from '@playwright/test';
test('failed speech survives reload, unit recovery is required before explicit save',async({page,request})=>{
 await request.post('http://127.0.0.1:8100/test/reset');
 let fail=true,units=false,saves=0;const bodies:unknown[]=[];
 await page.route('**/api/units',route=>units?route.fulfill({json:{items:[{id:'00000000-0000-4000-8000-000000000001',symbol:'g',dimension:'mass',base_factor:'1',aliases:[]}]}}):route.fulfill({status:503,json:{error:'temporary'}}));
 await page.route('**/api/voice-recipe',route=>{bodies.push(route.request().postDataJSON());return fail?route.fulfill({status:503,json:{error:'temporary'}}):route.fulfill({json:{title:'復旧パスタ',materials:[{name:'パスタ',quantity:'100',unit:'g',price_jpy:'350',price_quantity:'500',price_unit:'g',supplier:''}],selling_price_jpy:'',notes:[],missing:[],unitProposals:[]}});});
 await page.route('**/api/recipes/full',async route=>{saves++;return route.continue();});
 await page.goto('/');await page.getByLabel('音声認識できない場合の入力').fill('パスタ100g、500g350円');await page.getByRole('button',{name:'反映',exact:true}).click();
 await expect(page.getByRole('button',{name:'解析を再試行'})).toBeVisible();expect(saves).toBe(0);
 await page.reload();await page.getByRole('group',{name:'操作モード'}).getByRole('button',{name:'登録',exact:true}).click();
 await expect(page.getByRole('button',{name:'解析を再試行'})).toBeVisible();
 fail=false;await page.getByRole('button',{name:'解析を再試行'}).click();await expect(page.getByLabel('未保存のレシピ下書き')).toContainText('復旧パスタ');
 expect(bodies[1]).toEqual(bodies[0]);expect(saves).toBe(0);
 units=true;await page.getByRole('button',{name:'単位マスターを再取得'}).click();await expect(page.getByRole('button',{name:'単位マスターを再取得'})).toHaveCount(0);
 await page.getByRole('button',{name:'レシピを登録',exact:true}).click();await expect.poll(()=>saves).toBe(1);
});
