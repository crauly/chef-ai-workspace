import {test,expect,type Page} from '@playwright/test';
async function input(page:Page,text:string){await page.getByLabel('音声認識できない場合の入力').fill(text);await page.getByRole('button',{name:'反映',exact:true}).click();}
async function setup(page:Page,choose=false){
 const counts={review:0,save:0,reviewId:'',saveId:''};
 await page.route('**/api/voice-recipe',r=>r.fulfill({json:{title:'診断',materials:[{name:'しめじ',quantity:'20',unit:'g',price_jpy:'100',price_quantity:'100',price_unit:'g',supplier:''}],selling_price_jpy:'',notes:[],missing:[]}}));
 await page.route('**/api/recipes/full/review',r=>{const body=r.request().postDataJSON();const needsChoice=choose&&!body.materials[0].ingredient_id;counts.review++;counts.reviewId=body.request_id;return r.fulfill({json:{ingredients:[{name:'しめじ',action:needsChoice?'choose':'create',candidates:needsChoice?[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name:'しめじ'}]:[]}],units:[],suppliers:[]}});});
 await page.route('**/api/recipes/full',r=>{counts.save++;const b=r.request().postDataJSON();counts.saveId=b.request_id;return r.fulfill({json:{id:b.request_id,title:{value:b.title},revision:0,materials:[],selling_price_jpy:{value:null}}});});
 await page.goto('/');await input(page,'しめじ20gで診断レシピ');await expect(page.getByText('未保存の下書き：診断')).toBeVisible();return counts;
}
test('review 200 with choose blocks saving until selection and re-review',async({page})=>{
 const counts=await setup(page,true);await page.getByRole('button',{name:'レシピを登録',exact:true}).click();await expect(page.getByRole('button',{name:'承認して保存',exact:true})).toBeDisabled();await input(page,'保存してください');await expect(page.locator('.voice-detail-message')).toContainText('食材マスターの候補を選択');expect(counts.save).toBe(0);expect(counts.review).toBe(1);
 await page.getByLabel('しめじの食材マスター').selectOption('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');await page.getByRole('button',{name:'選択して再照合',exact:true}).click();await expect.poll(()=>counts.review).toBe(2);await expect(page.getByRole('button',{name:'承認して保存',exact:true})).toBeEnabled();await page.getByRole('button',{name:'承認して保存',exact:true}).click();await expect.poll(()=>counts.save).toBe(1);
});
test('local persistence failure releases busy and retries the same save ID',async({page})=>{
 const counts=await setup(page);await page.getByRole('button',{name:'レシピを登録',exact:true}).click();await expect(page.getByRole('button',{name:'承認して保存',exact:true})).toBeEnabled();
 await page.evaluate(()=>{const original=indexedDB.open.bind(indexedDB);indexedDB.open=()=>{indexedDB.open=original;throw new Error('diagnostic local persistence failure');};});await page.getByRole('button',{name:'承認して保存',exact:true}).click();await expect(page.locator('.voice-detail-message')).toContainText('保存IDを端末に保持できません');await expect(page.getByRole('button',{name:'承認して保存',exact:true})).toBeEnabled();expect(counts.save).toBe(0);await page.getByRole('button',{name:'承認して保存',exact:true}).click();await expect.poll(()=>counts.save).toBe(1);expect(counts.saveId).toBe(counts.reviewId);
});
test('pre-review queued save cannot approve; fresh save commits without a repeated review',async({page})=>{
 const counts=await setup(page);let release!:()=>void;const held=new Promise<void>(r=>release=r);
 await page.route('**/api/recipes/full/review',async r=>{counts.review++;if(counts.review===1)await held;await r.fulfill({json:{ingredients:[],units:[],suppliers:[]}});});
 await input(page,'保存してください');await expect.poll(()=>counts.review).toBe(1);await input(page,'保存してください');release();await expect(page.locator('.voice-detail-message')).toContainText('レビュー成立前');expect(counts.review).toBe(1);await expect(page.getByRole('button',{name:'承認して保存',exact:true})).toBeEnabled();expect(counts.save).toBe(0);await input(page,'承認して保存');await expect.poll(()=>counts.save).toBe(1);expect(counts.review).toBe(1);
});

for(const changesPrice of [false,true])test(`price research ${changesPrice?'changes facts and requires review':'only updates metadata and preserves approval'}`,async({page})=>{
 const counts=await setup(page);let release!:()=>void;const pending=new Promise<void>(r=>release=r);
 await page.route('**/api/voice-recipe',r=>r.fulfill({json:{title:'診断',materials:[{name:'しめじ',quantity:'20',unit:'g',price_jpy:'',price_quantity:'',price_unit:'',supplier:''}],selling_price_jpy:'',notes:[],missing:[],research_state:'deferred',pending_research:[{material_name:'しめじ',material_index:0,row_name:'しめじ',request:'価格を調べて',trigger:'muse'}]}}));
 await page.route('**/api/voice-recipe/prices',async r=>{await pending;await r.fulfill({json:{research_status:[],price_references:[],provisional_prices:[changesPrice?{material_index:0,material_name:'しめじ',origin:'ledger',price_jpy:'2',price_quantity:'1',price_unit:'g',currency:'JPY',observation_count:1,sources:[],fetched_at:null,status:'provisional',approval:'unapproved',text:'候補'}:null]}});});
 await input(page,'仕入価格は未確定です');await expect(page.getByRole('button',{name:'レシピを登録',exact:true})).toBeEnabled();await page.getByRole('button',{name:'レシピを登録',exact:true}).click();await expect(page.getByRole('button',{name:'承認して保存',exact:true})).toBeEnabled();release();
 if(changesPrice){await expect(page.getByRole('button',{name:'レシピを登録',exact:true})).toBeVisible();await expect(page.locator('.voice-detail-message')).toContainText('再レビュー');await input(page,'保存');await expect.poll(()=>counts.review).toBe(2);}
 else await expect(page.locator('[aria-label="未保存のレシピ下書き"]')).not.toContainText('調査中');
 await input(page,'保存');await expect.poll(()=>counts.save).toBe(1);expect(counts.review).toBe(changesPrice?2:1);
});
