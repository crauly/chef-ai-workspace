import {test,expect} from '@playwright/test';
import {voiceInput} from './voice-input';
const id='11111111-1111-4111-8111-111111111111',row='22222222-2222-4222-8222-222222222222';
test.beforeEach(async({request})=>{await request.post('http://127.0.0.1:8100/test/reset');});
async function open(page:import('@playwright/test').Page){await page.goto('/recipes/'+id);await page.getByRole('button',{name:'🎙 音声でレシピを修正'}).click();await expect(page.locator('#voice-controls')).toContainText('現在のモード: 編集');}
test('voice changes automatically open a review modal and voice consent saves only that proposal',async({page,request})=>{
 await open(page);await voiceInput(page,'片栗粉を15gに変更');
 const modal=page.getByRole('dialog',{name:'変更案の確認'});await expect(modal).toBeVisible();await expect(modal).toContainText('10 g → 15 g');
 expect((await (await request.get('http://127.0.0.1:8100/test/state')).json()).confirms).toHaveLength(0);
 await modal.getByRole('button',{name:'マイクを停止',exact:true}).click();
 await expect(modal.getByRole('button',{name:'音声で承認する'})).toBeEnabled();
 await page.evaluate(()=>{(window as any).previousVoiceFeed=(window as any).feedTestVoice;});
 await modal.getByRole('button',{name:'音声で承認する'}).click();
 await page.waitForFunction(()=>(window as any).feedTestVoice!==(window as any).previousVoiceFeed);
 await expect(modal.getByRole('button',{name:'マイクを停止',exact:true})).toBeVisible();
 await voiceInput(page,'更新して');await expect(modal).toHaveCount(0);await expect(page.getByRole('region',{name:'Recipe cost summary'})).toContainText('¥15');
 expect((await (await request.get('http://127.0.0.1:8100/test/state')).json()).confirms).toHaveLength(1);
});
test('additions and deletions show the resulting composition and button approval stays explicit',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 let saves=0;const attempts:unknown[]=[];
 await page.route('**/api/recipes/*/propose',route=>route.fulfill({json:{recipe_id:id,base_revision:0,requires_confirmation:true,operations:[{op:'remove_material',material_id:row},{op:'add_material',material_id:'55555555-5555-4555-8555-555555555555',name:'塩',quantity:'1',unit:'g',price_jpy:'100',price_quantity:'100',price_unit:'g'}]}}));
 await page.route('**/api/recipes/*/confirm',route=>{saves++;attempts.push(route.request().postDataJSON());return route.fulfill({status:502,json:{error:'retry'}});});
 await open(page);await voiceInput(page,'片栗粉を削除して塩1gを追加');
 const modal=page.getByRole('dialog',{name:'変更案の確認'});await expect(modal).toContainText('削除: 片栗粉');
 const composition=modal.getByRole('region',{name:'更新後の食材構成'});await expect(composition).toContainText('追加：塩');await expect(composition).not.toContainText('片栗粉');
 const save=modal.getByRole('button',{name:'承認して保存・原価再計算'});await expect(save).toBeDisabled();expect(saves).toBe(0);
 await expect(modal).toBeVisible();
 expect(await modal.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
 await page.screenshot({path:'/tmp/chef-edit-modal-mobile.png'});
 await modal.getByRole('checkbox').check();await save.click();await expect.poll(()=>saves).toBe(1);await expect(modal.getByRole('alert')).toBeVisible();
 await save.click();await expect.poll(()=>saves).toBe(2);expect(attempts[1]).toEqual(attempts[0]);
});
test('approval captured while a proposal is pending cannot save the later modal',async({page,request})=>{
 let release!:()=>void,started!:()=>void;const held=new Promise<void>(r=>release=r),sending=new Promise<void>(r=>started=r);
 await page.route('**/api/recipes/*/propose',async route=>{started();await held;await route.continue();});
 await open(page);await voiceInput(page,'片栗粉を15gに変更');await sending;
 await voiceInput(page,'承認');release();await expect(page.getByRole('dialog',{name:'変更案の確認'})).toBeVisible();
 await expect(page.locator('#voice-controls')).not.toContainText('操作を処理中');
 expect((await (await request.get('http://127.0.0.1:8100/test/state')).json()).confirms).toHaveLength(0);
 await voiceInput(page,'承認');await expect(page.getByRole('dialog')).toHaveCount(0);
});
