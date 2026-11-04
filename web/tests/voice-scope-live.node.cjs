// Opt-in, read-only live semantic scope checks. No ledger or DB writes.
require('./ts-require.cjs');
const {test}=require('node:test');const assert=require('node:assert/strict');
const {NextRequest}=require('next/server');const {POST}=require('../app/api/voice-recipe/route.ts');
test('live Spark resolves category, ASR, all and missing-price scopes', {skip:process.env.CHEF_LIVE_RECIPE_FLOW!=='1'},async()=>{
 process.loadEnvFile('../.env');process.env.DEMO_PREVIEW_PASSWORD='test-only-preview-password-32-characters';
 const names=['しめじ','えのき','マッシュルーム','パスタ','にんにく','オリーブオイル','塩','胡椒','バター','玉ねぎ'];
 const base={title:'キノコのパスタ',selling_price_jpy:'',notes:[],materials:names.map(name=>({name,quantity:'10',unit:'g',price_jpy:'',price_quantity:'',price_unit:'',supplier:''}))};
 for(const [text,expected] of [['このキノコ全部、価格調べて',[0,1,2]],['シメ字の平均価格を調べて',[0]],['一つずつ調べて入れて',names.map((_,i)=>i)],['仕入れ価格がないものを全部調べて',names.map((_,i)=>i).slice(1)]]){
  const previous=structuredClone(base);
  if(text.startsWith('仕入れ'))Object.assign(previous.materials[0],{price_jpy:'100',price_quantity:'100',price_unit:'g'});
  const req=new NextRequest('http://localhost/api/voice-recipe',{method:'POST',headers:{origin:'http://localhost',Authorization:'Basic '+Buffer.from('chef:'+process.env.DEMO_PREVIEW_PASSWORD).toString('base64')},body:JSON.stringify({previous,turns:[text],defer_prices:true})});
  const response=await POST(req);assert.equal(response.status,200,text);
  const body=await response.json();assert.deepEqual(body.pending_research.map(e=>e.material_index).sort((a,b)=>a-b),expected,text);
 }
});
