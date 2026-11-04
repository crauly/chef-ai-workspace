require('./ts-require.cjs');
const {test, beforeEach, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const {NextRequest} = require('next/server');
const {POST} = require('../app/api/recipe-price-research/route.ts');
const {combineResearch,isPriceResearchRequest,sourceUrl} = require('../recipe-price-research.ts');
const {explicitEditRequest,voiceNavigation} = require('../app/voice-navigation.ts');
const {selectReference} = require('../price-enrichment.ts');
const {renderToStaticMarkup} = require('react-dom/server');
const {createElement} = require('react');
const Evidence = require('../app/ResearchEvidence.tsx').default;
const PASSWORD='test-only-preview-password-32-characters';
const ID='11111111-1111-4111-8111-111111111111';
const units=[{id:'g-id',symbol:'g',dimension:'mass',base_factor:'1',aliases:['グラム']},
 {id:'kg-id',symbol:'kg',dimension:'mass',base_factor:'1000',aliases:[]}];
const line=i=>({id:`row-${i}`,material_name:{value:`食材${i}`,status:'confirmed'},quantity:{value:'100'},unit:'g',unit_id:'g-id',ingredient_id:`bbbbbbbb-bbbb-4bbb-8bbb-${String(i+1).padStart(12,'0')}`,price_mode:'inherit',supplier_id:null,offer_id:null});
let recipe, selection, calls, ledger, webResult, env, originalFetch, unitRows;
beforeEach(()=>{
 env={...process.env};originalFetch=global.fetch;
 process.env.MODEL_API_KEY='test-only-model';process.env.DEMO_PREVIEW_PASSWORD=PASSWORD;
 process.env.CHEF_FASTAPI_INTERNAL_URL='https://backend.test';process.env.DEMO_ACCESS_TOKEN='test-only-token';
 recipe={id:ID,revision:3,title:{value:'Recipe'},materials:Array.from({length:6},(_,i)=>line(i)),selling_price_jpy:{value:'1000'}};
 selection={indices:[0,1,2,3,4,5],edit_instruction:''};calls=[];unitRows=units;
 ledger=(name)=>({candidates:[{ingredient_id:recipe.materials.find(m=>m.material_name.value===name)?.ingredient_id,ingredient_name:name,
  reference:{available:true,currency:'JPY',unit_basis:'g',average_unit_price:'0.7600',observation_count:1,observed_to:'2026-11-04',observation_ids:['obs-1']},
  observations:[{observation_id:'obs-1',amount:'380',currency:'JPY',package_quantity:'500',package_unit:'g',source:'purchase',observed_at:'2026-11-04'}]}]});
 webResult=()=>({status:'completed',output:[{type:'web_search_call',status:'completed'},
  {type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify({candidates:[{name:'食材0',amount:'380',currency:'JPY',package_quantity:'500',package_unit:'g',seller:'Shop',source:'shop.test',url:'https://shop.test/product',tax_note:'税込',shipping_note:'別途'}]}),annotations:[{type:'url_citation',url:'https://shop.test/product',title:'Shop offer'}]}]}]});
 global.fetch=async(url,init={})=>{
  const target=new URL(String(url));calls.push({url:String(url),init});
  if(target.hostname==='backend.test'){
   assert.equal(init.method??'GET','GET');assert.equal(init.headers['X-Demo-Access'],'test-only-token');
   if(target.pathname===`/demo/recipes/${ID}`)return Response.json(recipe);
   if(target.pathname==='/demo/units')return Response.json({items:unitRows});
   if(target.pathname==='/demo/price-reference'){
    const id=target.searchParams.get('ingredient_id');
    assert(recipe.materials.some(m=>m.ingredient_id===id),'ledger lookup uses the exact saved ingredient identity');
    return Response.json(ledger(target.searchParams.get('name')));
   }
  }
  if(target.pathname==='/v1/chat/completions')return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(selection)}}]});
  if(target.pathname==='/v1/responses')return webResult();
  throw new Error('Unexpected network request: '+url);
 };
});
afterEach(()=>{global.fetch=originalFetch;for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);});
const body=(instruction='すべての食材の価格を調べて')=>({instruction,recipe_id:ID,base_revision:3});
function req(data=body(),headers={}){return new NextRequest('https://app.test/api/recipe-price-research',{method:'POST',headers:{origin:'https://app.test',authorization:'Basic '+Buffer.from('chef:'+PASSWORD).toString('base64'),...headers},body:JSON.stringify(data)});}
const run=async(data=body())=>{const response=await POST(req(data));assert.equal(response.status,200);return response.json();};

test('all selected rows (including 40) use real ledger enrichment, decimal prices, owned units and no web fallback',async()=>{
 recipe.materials=Array.from({length:40},(_,i)=>line(i));selection.indices=recipe.materials.map((_,i)=>i);
 const result=await run();assert.equal(result.operations.length,40);assert.equal(result.results.length,40);
 assert.equal(result.operations[39].price_jpy,'0.7600');assert.equal(result.results[0].reference.observations[0].observation_id,'obs-1');
 assert.equal(calls.filter(c=>c.url.includes('/v1/responses')).length,0);
 assert(calls.every(c=>!c.url.includes('/confirm')));
});
test('named subset and inclusive range preserve selected indices and do not truncate to three',async()=>{
 for(const [instruction,indices] of [['食材0と食材5の価格を調べて',[0,5]],['食材1から食材5まで価格を調べて',[1,2,3,4,5]]]){
  selection.indices=indices;const result=await run(body(instruction));assert.deepEqual(result.indices,indices);assert.equal(result.operations.length,indices.length);
 }
});
test('grounded web fallback carries URLs, package quotes, seller, timestamps and tax/shipping evidence',async()=>{
 selection.indices=[0];ledger=()=>({candidates:[]});global.fetch=((base)=>async(url,init)=>String(url).endsWith('/v1/responses')?Response.json(webResult()):base(url,init))(global.fetch);
 const result=await run();assert.equal(result.operations.length,1);
 const ref=result.results[0].reference;assert.equal(ref.origin,'external');assert.equal(ref.sources[0].url,'https://shop.test/product');assert.equal(ref.samples[0].seller,'Shop');assert(ref.fetched_at);assert.equal(ref.samples[0].tax_note,'税込');
 const html=renderToStaticMarkup(createElement(Evidence,{results:result.results,locale:'ja'}));
 assert.match(html,/https:\/\/shop.test\/product/);assert.match(html,/380/);assert.match(html,/500/);assert.match(html,/税込/);assert.match(html,/別途/);
});
test('failed grounding and incompatible/unknown units never become zero-valued mutations',async()=>{
 selection.indices=[0];ledger=()=>({candidates:[]});webResult=()=>Response.json({error:'upstream'}, {status:500});
 let result=await run();assert.equal(result.operations.length,0);assert.equal(result.results[0].research_status.web,'provider_error');
 ledger=name=>({candidates:[{ingredient_id:recipe.materials[0].ingredient_id,ingredient_name:name,reference:{available:true,currency:'JPY',unit_basis:'kg',average_unit_price:'120',observation_count:1}}]});
 unitRows=units.map(u=>({...u,base_factor:null}));result=await run();assert.equal(result.operations.length,0);assert.equal(result.results[0].status,'incompatible_unit');
 unitRows=units;result=await run();assert.equal(result.operations[0].price_unit,'kg');assert.equal(result.operations[0].price_jpy,'120');
});
test('supplier/offer identity is loaded from the owned recipe, never browser flags',async()=>{
 selection.indices=[0,1];recipe.materials[0].supplier_id='supplier';recipe.materials[1].offer_id='offer';
 const result=await run({...body(),materials:[{id:'row-0',supplier_id:null}]});
 assert.equal(result.operations.length,0);assert(result.results.every(r=>r.status==='linked_supplier'));
 assert(result.results.every(r=>r.reference.status==='available'));assert.equal(calls.filter(c=>c.url.includes('price-reference')).length,2);
});
test('auth, origin and stale revision fail before any model call',async()=>{
 assert.equal((await POST(req(body(),{authorization:'wrong'}))).status,403);
 assert.equal((await POST(req(body(),{origin:'https://other.test'}))).status,403);
 assert.equal((await POST(req({...body(),base_revision:2}))).status,409);
 assert.equal(calls.filter(c=>c.url.includes('meta.ai')).length,0);
});
test('ambiguous and malformed model scopes make no research or mutations',async()=>{
 selection.indices=[];let result=await run();assert.equal(result.ambiguous,true);assert.equal(result.operations.length,0);
 selection.indices=[99];assert.equal((await POST(req())).status,502);
 selection.indices=['0'];assert.equal((await POST(req())).status,502);
 assert.equal(calls.filter(c=>c.url.includes('price-reference')).length,0);
});
test('linked ingredient identity does not inherit a different product ledger quote',()=>{
 const ref=selectReference('Alias',0,{kind:'ok',candidates:[{ingredient_id:'foreign-product',ingredient_name:'Alias',reference:{available:true,currency:'JPY',unit_basis:'g',average_unit_price:'1'}}]},'selected-product');
 assert.notEqual(ref.status,'available');
});
test('research retains quantity/selling corrections, but never accepts invented proposal prices or stale revisions',()=>{
 const research={indices:[0],operations:[{op:'set_material_price',material_id:'row-0',price_jpy:'0.7600',price_quantity:'1',price_unit:'g'}],results:[],ambiguous:false};
 const edit={recipe_id:ID,base_revision:3,requires_confirmation:true,operations:[{op:'set_material_quantity',material_id:'row-0',value:'15',unit:'g'},{op:'set_selling_price',value_jpy:'1800'},{op:'set_material_price',material_id:'row-0',price_jpy:'999'}]};
 const proposal=combineResearch(recipe,research,edit);assert.deepEqual(proposal.operations.map(o=>o.op),['set_material_quantity','set_selling_price','set_material_price']);assert.equal(proposal.operations[2].price_jpy,'0.7600');assert.equal(proposal.requires_confirmation,true);
 assert.throws(()=>combineResearch(recipe,research,{...edit,base_revision:2}),/409/);
});
test('price research routing works from browse for Japanese/English orderings, not negatives or ordinary edits',()=>{
 for(const text of ['すべての材料の価格を調べて','食材0と食材5の相場を調査して','食材1から食材5まで価格を検索して','調べて、食材0の価格','look up prices for all ingredients','research prices for A and C']){
  assert.equal(isPriceResearchRequest(text),true,text);assert.equal(explicitEditRequest(text),true,text);assert.equal(voiceNavigation(text),null,text);
 }
 for(const text of ['価格を調べないで','do not research prices','使用量を15gに変更','仕入先を追加して'])assert.equal(isPriceResearchRequest(text),false,text);
});
test('only safe source URLs can render as approval evidence',()=>{
 assert.equal(sourceUrl('javascript:alert(1)'),null);assert.equal(sourceUrl('https://user:secret@shop.test'),null);assert.equal(sourceUrl('https://shop.test/product'),'https://shop.test/product');
});

test('external package conversion requires approved owner factors even if the normalized quote uses the recipe unit',async()=>{
 selection.indices=[0];ledger=()=>({candidates:[]});
 const original=webResult;
 webResult=()=>{const response=original();const part=response.output[1].content[0];const data=JSON.parse(part.text);data.candidates[0].package_quantity='1';data.candidates[0].package_unit='kg';part.text=JSON.stringify(data);return response;};
 global.fetch=((base)=>async(url,init)=>String(url).endsWith('/v1/responses')?Response.json(webResult()):base(url,init))(global.fetch);
 unitRows=units.map(u=>({...u,base_factor:null}));let result=await run();assert.equal(result.operations.length,0);assert.equal(result.results[0].status,'unverified_conversion');
 unitRows=units;result=await run();assert.equal(result.operations.length,1);assert.equal(result.operations[0].price_jpy,'0.3800');
 unitRows=units.map(u=>u.symbol==='kg'?{...u,base_factor:'900'}:u);result=await run();assert.equal(result.operations.length,0);assert.equal(result.results[0].status,'unverified_conversion');
});
test('combined instruction is returned for existing proposal generation, and a 41-operation save is rejected rather than truncated',async()=>{
 selection.indices=[0];selection.edit_instruction='食材0の使用量を15gに変更、売価を1800円に変更';
 const result=await run(body('食材0の価格を調べて、使用量を15g、売価を1800円に変更'));
 assert.equal(result.edit_instruction,selection.edit_instruction);
 const tooMany={...result,operations:Array.from({length:40},()=>result.operations[0])};
 assert.throws(()=>combineResearch(recipe,tooMany,{recipe_id:ID,base_revision:3,requires_confirmation:true,operations:[{op:'set_selling_price',value_jpy:'1800'}]}),/split/);
});
test('no fabricated zero, non-JPY or nonfinite ledger quote becomes a candidate',async()=>{
 selection.indices=[0];
 for(const [currency,price,status] of [['USD','1','unsupported_currency'],['JPY','NaN','invalid_price'],['JPY','0','invalid_price'],['JPY','Infinity','invalid_price']]){
  ledger=name=>({candidates:[{ingredient_id:recipe.materials[0].ingredient_id,ingredient_name:name,reference:{available:true,currency,unit_basis:'g',average_unit_price:price,observation_count:1}}]});
  const result=await run();assert.equal(result.operations.length,0);assert.equal(result.results[0].status,status);
 }
});

test('repeated ingredient IDs share a single researched master price across recipe lines',async()=>{
 selection.indices=[0,1];recipe.materials[1].ingredient_id=recipe.materials[0].ingredient_id;
 const result=await run();assert.equal(result.operations.length,2);assert.equal(result.results.length,2);
 assert.deepEqual(result.operations.map(op=>op.material_id),['row-0','row-1']);assert.equal(result.operations[0].price_jpy,result.operations[1].price_jpy);
 assert.equal(calls.filter(call=>call.url.includes('/demo/price-reference')).length,1);
});

test('a ledger quote unusable for JPY costing falls back to actual grounded research',async()=>{
 selection.indices=[0];ledger=name=>({candidates:[{ingredient_id:recipe.materials[0].ingredient_id,ingredient_name:name,
  reference:{available:true,currency:'USD',unit_basis:'g',average_unit_price:'1',observation_count:1}}]});
 global.fetch=((base)=>async(url,init)=>String(url).endsWith('/v1/responses')?Response.json(webResult()):base(url,init))(global.fetch);
 const result=await run();assert.equal(result.operations.length,1);assert.equal(result.results[0].reference.origin,'external');
 assert.equal(result.results[0].research_status.ledger,'available');assert.equal(result.results[0].research_status.web,'available');
});
