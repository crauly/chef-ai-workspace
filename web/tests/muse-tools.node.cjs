require('./ts-require.cjs');
const {test}=require('node:test');const assert=require('node:assert/strict');
const {NextRequest}=require('next/server');
const {POST:register}=require('../app/api/voice-recipe/route.ts');
const {POST:intent}=require('../app/api/intent/route.ts');
const {POST:propose}=require('../app/api/recipes/[id]/propose/route.ts');
const {museConversation}=require('../voice-recipe-provider.ts');
const {ownedMuseTools}=require('../muse-tools.ts');
const id='11111111-1111-4111-8111-111111111111';
const draft={title:'いつものパスタ',materials:[{name:'乾燥パスタ',quantity:'100',unit:'g',price_jpy:'',price_quantity:'',price_unit:'',supplier:''}],selling_price_jpy:'',notes:[],interpretations:[],price_research:[],name_corrections:[],unit_proposals:[],material_changes:[]};
Object.assign(process.env,{MODEL_API_KEY:'fixture',DEMO_ACCESS_TOKEN:'owner-bound-fixture',FASTAPI_BASE_URL:'http://127.0.0.1:8100',DEMO_PREVIEW_PASSWORD:'test-only-preview-password-32-characters'});
const req=(path,body)=>new NextRequest('http://localhost'+path,{method:'POST',headers:{origin:'http://localhost',authorization:'Basic '+Buffer.from('chef:'+process.env.DEMO_PREVIEW_PASSWORD).toString('base64')},body:JSON.stringify(body)});
const call=(name,args,n)=>({id:'call_'+n,type:'function',function:{name,arguments:JSON.stringify(args)}});
const response=(calls,content)=>Response.json({choices:[{finish_reason:calls?'tool_calls':'stop',message:{role:'assistant',content:content?JSON.stringify(content):null,...(calls?{tool_calls:calls}:{})}}]});
test('normal registration reads owned recipe and ledger tools, returns results to Muse, then validates a draft without writes',async()=>{
 const old=fetch;const model=[],reads=[];
 global.fetch=async(url,init)=>{
  if(String(url).includes('api.meta.ai')){
   const body=JSON.parse(init.body);model.push(body);assert.equal(body.tool_choice,'auto');
   if(model.length===1)return response([call('search_recipes',{query:'いつもの'},1),call('search_owned_ingredients',{query:'パスタ'},2)]);
   if(model.length===2){assert.equal(JSON.parse(body.messages.find(m=>m.tool_call_id==='call_1').content).items[0].id,id);return response([call('get_recipe',{recipe_id:id},3),call('get_price_reference',{query:'乾燥パスタ'},4)]);}
   assert.equal(JSON.parse(body.messages.find(m=>m.tool_call_id==='call_3').content).materials[0].quantity.value,'100');
   assert.equal(JSON.parse(body.messages.find(m=>m.tool_call_id==='call_4').content).adoption,'unapproved');
   return response(null,draft);
  }
  reads.push(String(url));assert.equal(init.method,'GET');assert.equal(init.headers['X-Demo-Access'],'owner-bound-fixture');
  const path=new URL(url).pathname;
  if(path==='/demo/recipes')return Response.json({items:[{id,title:'いつものパスタ'}]});
  if(path==='/demo/recipes/'+id)return Response.json({id,title:{value:'いつものパスタ'},materials:[{material_name:{value:'乾燥パスタ'},quantity:{value:'100'},unit:'g'}]});
  if(path==='/demo/ingredients/search')return Response.json({items:[{id,name:'乾燥パスタ'}]});
  if(path==='/demo/price-reference')return Response.json({candidates:[{ingredient_id:id,ingredient_name:'乾燥パスタ',reference:{available:true,average_unit_price:'1',unit_basis:'g',currency:'JPY'}}]});
  assert.fail(path);
 };
 try{const res=await register(req('/api/voice-recipe',{transcript:'いつものパスタと同じ材料と分量。価格も調べて',defer_prices:true}));assert.equal(res.status,200);assert.equal((await res.json()).materials[0].quantity,'100');assert.equal(reads.length,4);assert.equal(model.length,3);}finally{global.fetch=old;}
});
test('normal navigation resolves saved recipe through tool results',async()=>{
 const old=fetch;let models=0;
 global.fetch=async(url,init)=>{
  if(String(url).includes('api.meta.ai')){models++;if(models===1)return response([call('search_recipes',{query:'パスタ'},1)]);const body=JSON.parse(init.body);assert.equal(JSON.parse(body.messages.find(m=>m.role==='tool').content).items[0].title,'いつものパスタ');return response(null,{intent:'browse',target:'いつものパスタ'});}
  assert.equal(init.method,'GET');return Response.json({items:[{id,title:'いつものパスタ'}]});
 };
 try{const res=await intent(req('/api/intent',{utterance:'いつものパスタを見せて',current_mode:'idle'}));assert.equal(res.status,200);assert.equal((await res.json()).target,'いつものパスタ');assert.equal(models,2);}finally{global.fetch=old;}
});
test('ordinary edit proxy always enters existing tool-enabled proposal API',async()=>{
 const old=fetch;
 global.fetch=async(url,init)=>{assert.equal(new URL(url).searchParams.get('tools'),'ledger');assert.equal(new URL(url).pathname,'/demo/recipes/'+id+'/propose');assert.equal(init.method,'POST');return Response.json({operations:[],requires_confirmation:true});};
 try{const res=await propose(req('/api/recipes/'+id+'/propose',{instruction:'登録済みパスタへ関連付けて'}),{params:Promise.resolve({id})});assert.equal(res.status,200);}finally{global.fetch=old;}
});
test('tools reject write names, arbitrary IDs/owners and stop repeated model calls',async()=>{
 const execute=ownedMuseTools(),signal=new AbortController().signal;const old=fetch;let requests=0;
 global.fetch=async()=>{requests++;return response([call('search_recipes',{query:'x'},requests)]);};
 try{
  await assert.rejects(execute('save_recipe',{},signal),/unknown_tool/);
  assert.deepEqual(await execute('get_recipe',{recipe_id:id},signal),{error:'search_recipe_first'});
  assert.deepEqual(await execute('search_recipes',{query:'x',owner_id:'foreign'},signal),{error:'invalid_arguments'});assert.equal(requests,0);
  await assert.rejects(museConversation('k',[],{},signal,100,{rounds:0,execute:async()=>({items:[]})}),e=>e.code==='provider_unavailable');assert.equal(requests,3);
  requests=0;global.fetch=async()=>{requests++;return response([call('save_recipe',{},1)]);};await assert.rejects(museConversation('k',[],{},signal),e=>e.code==='provider_unavailable');assert.equal(requests,1);
 }finally{global.fetch=old;}
});
