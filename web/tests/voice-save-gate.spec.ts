import {test,expect,type Page} from '@playwright/test';
import {voiceInput} from './voice-input';
const draft={title:'保存テスト',materials:[{name:'しめじ',quantity:'20',unit:'g',price_jpy:'',price_quantity:'',price_unit:'',supplier:''}],selling_price_jpy:'',notes:[],missing:[]};
async function input(page:Page,text:string){await page.getByLabel('音声認識できない場合の入力').fill(text);await page.getByRole('button',{name:'反映',exact:true}).click();}
const saveButton=(page:Page)=>page.getByRole('button',{name:/^(レシピを登録|承認して保存)$/});
async function setup(page:Page,value:any=draft){
 const bodies:any[]=[];let reviews=0;
 await page.route('**/api/voice-recipe',r=>r.fulfill({json:value}));
 page.on('request',r=>{if(r.url().endsWith('/recipes/full'))bodies.push(r.postDataJSON());if(r.url().endsWith('/recipes/full/review'))reviews++;});
 await page.goto('/');return {bodies,reviews:()=>reviews};
}
test.beforeEach(async({request})=>{await request.post('http://127.0.0.1:8100/test/reset');});
test('one spoken save persists incomplete facts and displays gaps after reload',async({page})=>{
 const state=await setup(page,{...draft,title:'',materials:[{...draft.materials[0],quantity:'2',unit:'束'}],notes:['価格不明'],missing:['料理名','数量・単位']});
 await voiceInput(page,'しめじ、数量と価格はあとで');await expect(page.getByLabel('未保存のレシピ下書き')).toBeVisible();
 await voiceInput(page,'保存して');await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]+$/);expect(state.bodies).toHaveLength(1);expect(state.reviews()).toBe(0);
 expect(state.bodies[0]).toMatchObject({title:'無題のレシピ',unit_candidates:[],materials:[{name:'しめじ',quantity:null,unit:null,price_jpy:null,price_quantity:null,price_unit:null}]});
 await page.reload();await expect(page.getByRole('heading',{name:'無題のレシピ',exact:true})).toBeVisible();await page.locator('.recipe-gap-disclosure').getByText(/未確定情報/).click();await expect(page.locator('.recipe-gap-disclosure')).toContainText('しめじ：使用量・単位');await expect(page.locator('.recipe-gap-disclosure')).toContainText('しめじ：仕入単価');
});
test('one button click saves without a mandatory preflight',async({page})=>{
 const state=await setup(page);await input(page,'しめじ20g、価格不明');await expect(saveButton(page)).toBeEnabled();await saveButton(page).click();await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]+$/);expect(state.bodies).toHaveLength(1);expect(state.reviews()).toBe(0);
});
test('local persistence failure releases busy; an uncertain POST retry keeps its ID and payload',async({page})=>{
 const state=await setup(page);await input(page,'しめじ20g');await expect(saveButton(page)).toBeEnabled();
 await page.evaluate(()=>{const original=indexedDB.open.bind(indexedDB);indexedDB.open=()=>{indexedDB.open=original;throw new Error('local persistence unavailable');};});
 await saveButton(page).click();await expect(page.locator('.voice-detail-message')).toContainText('保存IDを端末に保持できません');await expect(saveButton(page)).toBeEnabled();expect(state.bodies).toHaveLength(0);
 let fail=true;await page.route('**/api/recipes/full',async r=>{if(fail){fail=false;await r.abort();}else await r.fallback();});
 await saveButton(page).click();await expect(page.locator('.voice-detail-message')).toContainText('結果未確認');await expect(saveButton(page)).toBeEnabled();await saveButton(page).click();await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]+$/);expect(state.bodies).toHaveLength(2);expect(state.bodies[1]).toEqual(state.bodies[0]);
});
test('a save queued during parsing waits for that draft and commits only once',async({page})=>{
 const state=await setup(page);let release!:()=>void;const pending=new Promise<void>(r=>release=r);let parsing=false;
 await page.route('**/api/voice-recipe',async r=>{parsing=true;await pending;await r.fulfill({json:draft});});
 await voiceInput(page,'しめじ20g');await expect.poll(()=>parsing).toBe(true);await voiceInput(page,'保存');await voiceInput(page,'保存');expect(state.bodies).toHaveLength(0);release();await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]+$/);expect(state.bodies).toHaveLength(1);
});
test('audio recorded for a discarded draft cannot save the replacement',async({page})=>{
 const state=await setup(page);await voiceInput(page,'しめじ20g');await expect(saveButton(page)).toBeEnabled();
 let release!:()=>void;const pending=new Promise<void>(r=>release=r);let received=false;const held=async(r:any)=>{received=true;await pending;await r.fulfill({json:{transcript:'保存'}});};
 await page.route('**/api/voice/transcribe',held);await page.evaluate(()=>(window as any).feedTestVoice());await expect.poll(()=>received).toBe(true);await page.getByRole('button',{name:'下書きを破棄',exact:true}).click();await input(page,'新しいしめじ料理');await expect(saveButton(page)).toBeEnabled();release();await expect(page.locator('.voice-detail-message')).toContainText('別の下書き');expect(state.bodies).toHaveLength(0);await page.unroute('**/api/voice/transcribe',held);await voiceInput(page,'保存');await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]+$/);expect(state.bodies).toHaveLength(1);
});
test('save does not wait for price research or adopt its late candidate',async({page})=>{
 const pendingEntry={material_name:'しめじ',material_index:0,row_name:'しめじ',request:'価格を調べて',trigger:'muse'};
 const state=await setup(page,{...draft,research_state:'deferred',pending_research:[pendingEntry]});let release!:()=>void;const pending=new Promise<void>(r=>release=r);let researching=false;
 await page.route('**/api/voice-recipe/prices',async r=>{researching=true;await pending;try{await r.fulfill({json:{research_status:[],price_references:[],provisional_prices:[]}});}catch{}});
 await input(page,'しめじ20g、価格を調べて');await expect.poll(()=>researching).toBe(true);await expect(saveButton(page)).toBeEnabled();await input(page,'保存');await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]+$/);release();expect(state.bodies).toHaveLength(1);expect(state.bodies[0].materials[0].price_jpy).toBeNull();
});
