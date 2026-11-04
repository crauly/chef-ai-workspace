import {test,expect} from '@playwright/test';
test.skip(!process.env.CHEF_TEST_PGPORT,'requires disposable local PostgreSQL');
test('browser → Next → FastAPI → PostgreSQL: approve, reload, rollback, retry and replay',async({page,request})=>{
 const state=async()=>await (await request.get('http://127.0.0.1:8103/test/state')).json();
 const initial=await state();await page.goto('/settings?section=ingredient');
 await page.getByRole('button',{name:'編集',exact:true}).click();let dialog=page.getByRole('dialog');
 await expect(dialog.getByLabel('仕入れ先（採用価格）')).toBeEnabled();
 await dialog.getByLabel('食材名',{exact:true}).fill('統合保存パスタ');await dialog.getByLabel('規格（商品の識別用）').fill('500g袋');
 await dialog.getByLabel('仕入れ先（採用価格）').selectOption(initial.supplier);await dialog.getByLabel('仕入価格（円）').fill('400');await dialog.getByRole('switch').check();
 await dialog.getByRole('button',{name:'保存',exact:true}).click();expect((await state()).row.name).toBe('パスタ');
 await page.getByRole('button',{name:'承認して保存'}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 const saved=await state();expect(saved.row.name).toBe('統合保存パスタ');expect(saved.row.price_research_enabled).toBe(true);expect(saved.observations).toBe(initial.observations+1);
 for(const [i,cost] of ['80','120'].entries()){const result=await request.get('/api/recipes/'+initial.recipes[i]+'/cost');expect((await result.json()).total_cost_jpy).toBe(cost);}
 await page.reload();await expect(page.getByRole('row',{name:/統合保存パスタ/})).toContainText('Amazon: ¥400 / 500 g');
 await page.getByRole('button',{name:'編集',exact:true}).click();dialog=page.getByRole('dialog');await expect(dialog.getByLabel('仕入価格（円）')).toHaveValue('400');
 await dialog.getByLabel('規格（商品の識別用）').fill('規格だけ変更');await dialog.getByRole('button',{name:'保存',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect((await state()).observations).toBe(saved.observations);
 await page.getByRole('button',{name:'編集',exact:true}).click();dialog=page.getByRole('dialog');await expect(dialog.getByLabel('仕入価格（円）')).toHaveValue('400');
 await dialog.getByLabel('食材名',{exact:true}).fill('失敗後も保持');await dialog.getByLabel('仕入価格（円）').fill('450');await dialog.getByRole('switch').uncheck();
 await request.post('http://127.0.0.1:8103/test/fault/1');let payload:any;
 page.on('request',r=>{if(r.method()==='PUT'&&r.url().endsWith('/api/ingredients/'+initial.ingredient))payload=r.postDataJSON();});
 await dialog.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('button',{name:'承認して保存'}).click();
 await expect(page.getByRole('dialog').getByRole('alert')).toContainText('データベース');expect((await state()).row.name).toBe('統合保存パスタ');expect((await state()).observations).toBe(saved.observations);
 await expect(page.getByRole('dialog').getByLabel('食材名',{exact:true})).toHaveValue('失敗後も保持');
 const failedPayload=payload;await request.post('http://127.0.0.1:8103/test/fault/0');await page.getByRole('dialog').getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('button',{name:'承認して保存'}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 expect(payload).toEqual(failedPayload);const result=await request.put('/api/ingredients/'+initial.ingredient,{data:payload,headers:{Origin:'http://localhost:3103'}});expect(result.ok()).toBe(true);expect((await result.json()).replayed).toBe(true);expect((await state()).observations).toBe(saved.observations+1);
 await page.reload();await page.getByRole('button',{name:'編集',exact:true}).click();await expect(page.getByRole('dialog').getByLabel('仕入価格（円）')).toHaveValue('450');await expect(page.getByRole('dialog').getByRole('switch')).not.toBeChecked();
});
