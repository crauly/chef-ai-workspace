import {test,expect,type Page} from '@playwright/test';
const material={name:'青菜',quantity:'2',unit:'束',price_jpy:'300',price_quantity:'1',price_unit:'束',supplier:''};
const draft={title:'レビュー野菜',materials:[material],selling_price_jpy:'',notes:[],missing:[],unitProposals:[{symbol:'束',dimension:'count'}]};
async function input(page:Page,text:string){await page.getByLabel('音声認識できない場合の入力').fill(text);await page.getByRole('button',{name:'反映',exact:true}).click();}
const plan=(body:any,already_saved=false)=>({already_saved,ingredients:body.materials.map((m:any)=>({name:m.name,action:already_saved?'reuse':'create'})),units:already_saved?[]:body.unit_candidates,suppliers:[]});

test('unit dimension change during preflight invalidates the response and requires a new plan',async({page})=>{
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const reviews:any[]=[];let saved:any=null;
 await page.route('**/api/units',route=>route.fulfill({json:{items:[]}}));
 await page.route(/\/api\/voice-recipe$/,route=>route.fulfill({json:draft}));
 await page.route('**/api/recipes/full/review',async route=>{const body=route.request().postDataJSON();reviews.push(body);if(reviews.length===1)await gate;await route.fulfill({json:plan(body)});});
 await page.route('**/api/recipes/full',async route=>{saved=route.request().postDataJSON();await route.fulfill({status:201,json:{id:saved.request_id,title:{value:saved.title},revision:0,materials:[],selling_price_jpy:{value:null}}});});
 await page.goto('/');await input(page,'青菜2束、1束300円');await expect(page.getByLabel('束の単位分類')).toHaveValue('count');
 await input(page,'内容を確認');await expect.poll(()=>reviews.length).toBe(1);
 await page.getByLabel('束の単位分類').selectOption('mass');const replied=page.waitForResponse(r=>r.url().endsWith('/api/recipes/full/review'));release();await replied;await page.waitForTimeout(100);
 await expect(page.getByLabel('正式登録の確認')).toHaveCount(0);expect(saved).toBeNull();
 await input(page,'内容を確認');await expect(page.getByLabel('正式登録の確認')).toContainText('mass');
 expect(reviews).toHaveLength(2);expect(reviews[1].unit_candidates).toEqual([{symbol:'束',dimension:'mass'}]);
 await page.getByRole('button',{name:'承認して保存',exact:true}).click();await expect.poll(()=>saved).not.toBeNull();expect(saved).toEqual(reviews[1]);
});

test('a correction clears a found price while retaining its candidate for manual adoption',async({page})=>{
 let parses=0;const m={...material,name:'パスタ',quantity:'100',unit:'g',price_jpy:'',price_quantity:'',price_unit:''};
 const pending=[{material_name:'パスタ',row_name:'パスタ',material_index:0,request:'平均価格を調べて',trigger:'muse'}];
 await page.route(/\/api\/voice-recipe$/,route=>{parses++;return route.fulfill({json:{...draft,materials:[m],unitProposals:[],missing:['パスタの仕入単価・基準数量・単位'],research_state:'deferred',pending_research:parses===1?pending:[],provisional_prices:[null]}});});
 await page.route('**/api/voice-recipe/prices',route=>route.fulfill({json:{research_state:'complete',price_references:[],research_status:[{...pending[0],ledger:'none',web:'available',provisional:true}],provisional_prices:[{material_name:'パスタ',material_index:0,origin:'external',price_jpy:'2',price_quantity:'1',price_unit:'g',currency:'JPY',observation_count:2,sources:[],fetched_at:null,status:'provisional',approval:'unapproved',text:'参考候補'}]}}));
 await page.goto('/');await input(page,'パスタ100g、価格を調べて');await expect(page.getByLabel('未保存のレシピ下書き')).toContainText('仕入価格 ¥2 / 1g');
 await input(page,'その価格は採用しない。仕入価格を削除して未確定に戻して');await expect.poll(()=>parses).toBe(2);
 await expect(page.getByLabel('未保存のレシピ下書き')).toContainText('仕入価格 未設定');
 await page.getByRole('button',{name:'価格の詳細・出典',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'価格の調査結果'})).toContainText('¥2');
 await page.getByRole('dialog',{name:'価格の調査結果'}).getByRole('button',{name:'閉じる',exact:true}).click();
 await page.getByRole('button',{name:'この価格を使う',exact:true}).click();
 await expect(page.getByLabel('未保存のレシピ下書き')).toContainText('仕入価格 ¥2 / 1g');
});

test('reload after a lost committed response retains the exact payload and request id',async({page,request})=>{
 await request.post('http://127.0.0.1:8100/test/reset');let committed:any=null;let saveCalls=0;const reviews:any[]=[];
 await page.route('**/api/units',route=>route.fulfill({json:{items:committed?[{id:'unit-bundle',symbol:'束',dimension:'count',aliases:[]}]:[]}}));
 await page.route(/\/api\/voice-recipe$/,route=>route.fulfill({json:draft}));
 await page.route('**/api/recipes/full/review',route=>{const body=route.request().postDataJSON();reviews.push(body);if(committed)expect(body).toEqual(committed);return route.fulfill({json:plan(body,Boolean(committed))});});
 await page.route('**/api/recipes/full',async route=>{saveCalls++;const body=route.request().postDataJSON();if(saveCalls===1){committed=body;await route.fetch();await route.abort('failed');}else{expect(body).toEqual(committed);await route.continue();}});
 await page.goto('/');await input(page,'青菜2束、1束300円');await page.getByRole('button',{name:'レシピを登録',exact:true}).click();
 await expect(page.getByText('通信失敗により結果未確認です。',{exact:false})).toBeAttached();expect(saveCalls).toBe(1);
 await page.reload();await page.getByRole('group',{name:'操作モード'}).getByRole('button',{name:'登録',exact:true}).click();await expect(page.getByLabel('未保存のレシピ下書き')).toBeVisible();
 await page.getByRole('button',{name:'レシピを登録',exact:true}).click();await expect(page.getByRole('region',{name:'レシピ詳細'})).toBeVisible();
 expect(saveCalls).toBe(2);expect(reviews).toHaveLength(0);
 const list=await (await request.get('/api/recipes?q='+encodeURIComponent(draft.title))).json();expect(list.items.filter((r:any)=>r.id===committed.request_id)).toHaveLength(1);
});
