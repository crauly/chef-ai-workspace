require('./ts-require.cjs');
const {test}=require('node:test');const assert=require('node:assert/strict');
const {assembleEntries,enrichEntries}=require('../price-enrichment.ts');
const {voiceRecipeModel}=require('../voice-recipe-provider.ts');
const materials=Array.from({length:10},(_,i)=>({name:'食材'+i,quantity:'10',unit:'g',price_jpy:'',price_quantity:'',price_unit:'',supplier:''}));
test('all ten requested rows survive assembly and bounded ledger lookup',async()=>{
 const old=global.fetch;process.env.FASTAPI_BASE_URL='http://localhost:9';process.env.DEMO_ACCESS_TOKEN='test';
 let active=0,peak=0,calls=0;
 global.fetch=async url=>{active++;peak=Math.max(peak,active);calls++;await new Promise(r=>setTimeout(r,2));active--;
 const name=new URL(url).searchParams.get('name');return Response.json({candidates:[{ingredient_id:name,ingredient_name:name,reference:{available:true,currency:'JPY',unit_basis:'g',average_unit_price:'1',observation_count:1}}]});};
 try{const entries=assembleEntries(materials,materials.map((m,i)=>({material_name:m.name,material_index:i,request:'全部の平均価格を調べて'})),['全部の平均価格を調べて']);assert.equal(entries.length,10);const result=await enrichEntries('test',entries);assert.equal(calls,10);assert(peak<=3);assert.equal(result.researchStatus.length,10);assert(result.researchStatus.every(s=>s.provisional));}finally{global.fetch=old;}
});
test('category request never expands model-selected mushrooms to other ingredients',()=>{
 const rows=[...materials,{...materials[0],name:'しめじ'}];
 const entries=assembleEntries(rows,[{material_name:'しめじ',material_index:10,request:'このキノコ全部、価格調べて'}],['このキノコ全部、価格調べて']);assert.equal(entries.length,1);
});
test('transport failure never starts another slow model call',async()=>{
 const old=global.fetch;let calls=0;global.fetch=async()=>{calls++;return new Response('',{status:504});};
 try{await assert.rejects(voiceRecipeModel('x','x',{},new AbortController().signal,{}),e=>e.code==='provider_unavailable');assert.equal(calls,1);}finally{global.fetch=old;}
});
test('malformed model JSON repairs without fabricating missing facts',async()=>{
 const old=global.fetch;let calls=0;global.fetch=async()=>Response.json({choices:[{finish_reason:'stop',message:{content:++calls===1?'bad JSON':JSON.stringify({title:'料理',materials,notes:[],selling_price_jpy:'',unit_proposals:[]})}}]});
 try{const draft=await voiceRecipeModel('x','x',{},new AbortController().signal,{});assert.equal(calls,2);assert.equal(draft.materials.length,10);assert.equal(draft.materials[0].price_jpy,'');}finally{global.fetch=old;}
});
test('a schema-valid empty shell cannot erase an existing recipe revision',async()=>{
 const old=global.fetch;let calls=0;global.fetch=async()=>{calls++;return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({title:'',materials:[],notes:[],selling_price_jpy:''})}}]});};
 try{await assert.rejects(voiceRecipeModel('x','x',{previous_draft:{title:'パスタ',materials}},new AbortController().signal,{}),e=>e.code==='invalid_response');assert.equal(calls,2);}finally{global.fetch=old;}
});
test('all named mushrooms never expands a correct Muse subset to unrelated rows',()=>{
 const rows=['しめじ','えのき','パスタ'].map(name=>({...materials[0],name}));
 const request='しめじとえのきの価格を全部調べて';
 const entries=assembleEntries(rows,[{material_name:'しめじ',material_index:0,request},{material_name:'えのき',material_index:1,request}],[request]);
 assert.deepEqual(entries.map(e=>e.material_index),[0,1]);
 const priced=rows.map((m,i)=>i===0?{...m,price_jpy:'100',price_quantity:'100',price_unit:'g'}:m);
 assert.deepEqual(assembleEntries(priced,[{material_name:'しめじ',material_index:0,request:'しめじの価格を全部調べて'}],['しめじの価格を全部調べて']).map(e=>e.material_index),[0]);
 assert.equal(assembleEntries(rows,[],['しめじ20g。全部の食材の価格を調べて']).length,3);
});
test('partial model omission cannot silently drop eggs from a populated draft',async()=>{
 const old=global.fetch;let calls=0;const rows=['自家製グアンチャーレ','ペコリーノロマーノ','乾燥パスタ 1.9ミリ ディチェコ','鶏卵'].map(name=>({...materials[0],name}));
 global.fetch=async()=>{calls++;return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({title:'カルボナーラ',materials:calls===1?rows.slice(0,3):rows,notes:[],selling_price_jpy:'',material_changes:[]})}}]});};
 try{const result=await voiceRecipeModel('x','x',{previous_draft:{title:'カルボナーラ',materials:rows},new_turns:['パスタを120gにしてください']},new AbortController().signal,{});assert.equal(calls,2);assert.equal(result.materials.length,4);assert.equal(result.materials[3].name,'鶏卵');}finally{global.fetch=old;}
});
test('intentional removals and renames must be declared and visible for review',async()=>{
 const old=global.fetch;const rows=[{...materials[0],name:'鶏卵'},{...materials[0],name:'パスタ'}];
 global.fetch=async()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({title:'カルボナーラ',materials:[{...rows[1],name:'乾燥パスタ'}],notes:[],selling_price_jpy:'',material_changes:[{previous_name:'鶏卵',action:'remove',replacement_name:''},{previous_name:'パスタ',action:'rename',replacement_name:'乾燥パスタ'}]})}}]});
 try{const result=await voiceRecipeModel('x','x',{previous_draft:{title:'カルボナーラ',materials:rows}},new AbortController().signal,{});assert.equal(result.materials.length,1);assert.equal(result.interpretations[0].source,'鶏卵');assert.equal(result.interpretations[0].suggestion,'削除');}finally{global.fetch=old;}
});
