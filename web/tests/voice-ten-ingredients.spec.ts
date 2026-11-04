import {test,expect} from '@playwright/test';
import {voiceInput} from './voice-input';
const live=process.env.CHEF_LIVE_RECIPE_FLOW==='1';
test('ten ingredients: correction during research, review, approval and reload',async({page,request},info)=>{
 test.setTimeout(live?360000:60000);
 const names=['しめじ','えのき','マッシュルーム','パスタ','にんにく','オリーブオイル','塩','胡椒','明治のバター','玉ねぎ'];
 let parsed:any,submitted:any,parseCalls=0,saves=0;const requested=new Set<string>();
 if(!live){
  await page.route(/\/api\/voice-recipe$/,async route=>{
   const body=route.request().postDataJSON();parseCalls++;
   if(parseCalls===2){expect(body.turns).toHaveLength(1);expect(body.previous.materials).toHaveLength(10);expect(body.previous.price_references).toBeUndefined();expect(body.previous.provisional_prices).toBeUndefined();}
   parsed={title:'キノコのパスタ',selling_price_jpy:'',notes:[],missing:[],materials:names.map((name,i)=>({name:parseCalls>1&&i===8?'雪印のバター':parseCalls>1&&i===2?'ブラウンマッシュルーム':name,quantity:i===0?'20':parseCalls>1&&i===1?'25':'15',unit:i===5?'ml':'g',supplier:i===8?(parseCalls>1?'スーパーB':'スーパーA'):'',price_jpy:'',price_quantity:'',price_unit:''})),research_state:'deferred'};
   parsed.pending_research=parsed.materials.map((m:any,i:number)=>({material_name:m.name,material_index:i,row_name:m.name,request:'全部の平均価格を調べて',trigger:'muse'}));
   await route.fulfill({json:parsed});
  });
  await page.route('**/api/voice-recipe/prices',async route=>{
   const {entries,materials}=route.request().postDataJSON();expect(entries.length).toBeLessThanOrEqual(2);
   entries.forEach((e:any)=>requested.add(e.material_name));await new Promise(r=>setTimeout(r,200));
   await route.fulfill({json:{research_state:'complete',price_references:[],research_status:entries.map((e:any)=>({...e,ledger:'none',web:e.material_index===9?'empty':'available',provisional:e.material_index!==9})),provisional_prices:materials.map((m:any,i:number)=>entries.some((e:any)=>e.material_index===i)&&i!==9?{material_name:m.name,material_index:i,origin:'external',price_jpy:'2',price_quantity:'1',price_unit:i===5?'ml':'g',currency:'JPY',observation_count:2,sources:[{url:'https://example.com/price',title:'Test source'}],fetched_at:'2026-11-04',status:'provisional',approval:'unapproved',text:'参考候補'}:null)}});
  });
 }
 page.on('request',req=>{if(req.url().endsWith('/api/recipes/full')&&req.method()==='POST')submitted=req.postDataJSON();});
 page.on('response',async response=>{
  if(response.url().endsWith('/api/voice-recipe')&&response.ok()){parsed=await response.json();console.log('draft',JSON.stringify({timing:response.headers()['server-timing'],rows:parsed.materials.map((m:any)=>[m.name,m.quantity,m.supplier]),targets:parsed.pending_research?.length}));}
  if(response.url().endsWith('/api/voice-recipe/prices')&&response.ok()){
   const body=await response.json();body.research_status.forEach((e:any)=>requested.add(e.material_name));console.log('prices',JSON.stringify(body.research_status.map((s:any)=>({name:s.material_name,web:s.web,ledger:s.ledger}))));
  }
  if(response.url().endsWith('/api/recipes/full/review'))console.log('review',response.status(),await response.text());
  if(response.url().endsWith('/api/recipes/full')&&response.ok())saves++;
 });
 await page.goto('/');await page.getByRole('button',{name:'登録',exact:true}).click();
 await voiceInput(page,'キノコのパスタを作ります。しめじ30g、えのき15g、マッシュルーム15g、パスタ100g、にんにく5g、オリーブオイル10ml、塩2g、胡椒1g、バター10g、玉ねぎ20g。あ、しめじは20gに変更してください。バターは明治のもの、購入先はスーパーAです。全部の平均仕入れ価格を調べてください。');
 const draft=page.getByLabel('未保存のレシピ下書き');await expect(draft).toContainText('しめじ — 20g',{timeout:30000});
 expect(parsed.materials).toHaveLength(10);expect(parsed.pending_research).toHaveLength(10);expect(saves).toBe(0);
 await expect(draft).toContainText('価格を検索しています');
 await voiceInput(page,'えのきは25グラム。バターは雪印に訂正、購入先はスーパーBです。マッシュルームをブラウンマッシュルームに変更してください。');
 await expect(draft).toContainText('えのき — 25g',{timeout:30000});await expect(draft).toContainText('雪印');await expect(draft).toContainText('スーパーB');
 await expect(draft.getByRole('status').filter({hasText:'価格を検索しています'})).toHaveCount(0,{timeout:240000});
 expect(parsed.materials).toHaveLength(10);
 for(const material of parsed.materials)expect(requested.has(material.name),material.name+' researched').toBe(true);
 expect(saves).toBe(0);await voiceInput(page,'保存して');
 await expect(page.getByLabel('正式登録の確認')).toBeVisible({timeout:30000});expect(saves).toBe(0);
 await voiceInput(page,'保存して');await expect(page.getByRole('region',{name:'レシピ詳細'})).toBeVisible({timeout:30000});expect(saves).toBe(1);
 const response=await request.get('/api/recipes?q='+encodeURIComponent('キノコのパスタ'));
 expect(response.ok()).toBe(true);const list=await response.json();
 const item=list.items.find((r:any)=>(typeof r.title==='string'?r.title:r.title?.value)==='キノコのパスタ');expect(item).toBeTruthy();
 const saved=await (await request.get('/api/recipes/'+item.id)).json();
 expect(saved.materials).toHaveLength(10);expect(saved.materials.find((m:any)=>m.material_name.value==='えのき').quantity.value).toBe('25');
 for(const expected of submitted.materials){
  const row=saved.materials.find((m:any)=>m.material_name.value===expected.name);
  expect(row.quantity.value).toBe(expected.quantity);expect(row.unit).toBe(expected.unit);
  if(live){
   if(expected.supplier)expect(row.supplier_name).toBe(expected.supplier);
   if(expected.price_jpy){expect(Number(row.effective_price.amount_jpy.value)).toBe(Number(expected.price_jpy));expect(Number(row.effective_price.per_quantity)).toBe(Number(expected.price_quantity));expect(row.effective_price.per_unit).toBe(expected.price_unit);}
   else expect(row.effective_price).toBeNull();
  }
 }
 if(live){
  const reuse=await request.post('/api/recipes/full/review',{headers:{Origin:'http://localhost:3102'},data:{...submitted,request_id:crypto.randomUUID()}});
  expect(reuse.ok()).toBe(true);expect((await reuse.json()).ingredients.every((m:any)=>m.action==='reuse')).toBe(true);
 }
 await page.reload();
 await expect(page.getByRole('region',{name:'レシピ詳細'})).toContainText('えのき');
 await info.attach('saved-recipe-after-reload',{body:await page.screenshot({fullPage:true}),contentType:'image/png'});
 console.log('complete',JSON.stringify({live,requested:[...requested],saves,rows:saved.materials.length}));
});
