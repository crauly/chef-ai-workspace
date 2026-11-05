require('./ts-require.cjs');
const {test}=require('node:test');const assert=require('node:assert/strict');
const {NextRequest}=require('next/server');const {POST}=require('../app/api/voice-recipe/route.ts');
const draft={title:'パスタ',materials:[{name:'パスタ',quantity:'100',unit:'g',price_jpy:'350',price_quantity:'500',price_unit:'g',supplier:''}],selling_price_jpy:'',notes:[],interpretations:[],price_research:[],name_corrections:[],unit_proposals:[]};
function req(){return new NextRequest('http://localhost/api/voice-recipe',{method:'POST',headers:{origin:'http://localhost',authorization:'Basic '+Buffer.from('chef:'+process.env.DEMO_PREVIEW_PASSWORD).toString('base64')},body:JSON.stringify({turns:['パスタ100g'],defer_prices:true})});}
test('unit outage does not block the unsaved recipe draft',async()=>{
 Object.assign(process.env,{MODEL_API_KEY:'fixture',DEMO_ACCESS_TOKEN:'fixture',FASTAPI_BASE_URL:'http://127.0.0.1:8100',DEMO_PREVIEW_PASSWORD:'test-only-preview-password-32-characters'});
 const original=global.fetch;let calls=0;global.fetch=async url=>{if(String(url).includes('/demo/units'))return new Response('',{status:503});calls++;return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(draft)}}]});};
 try{const res=await POST(req());assert.equal(res.status,200);assert.equal((await res.json()).materials[0].quantity,'100');assert.equal(calls,1);}finally{global.fetch=original;}
});
const {voiceRecipeModel,normalizedDraft,VoiceRecipeFailure}=require('../voice-recipe-provider.ts');
test('bounded regeneration repairs structure and numeric representations without inventing facts',async()=>{
 const original=global.fetch;let calls=0;global.fetch=async()=>{calls++;return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(calls===1?{materials:'invalid'}:{...draft,materials:[{...draft.materials[0],quantity:100,price_jpy:null,price_quantity:null,price_unit:null}]})}}]});};
 try{const out=await voiceRecipeModel('k','system',{},new AbortController().signal,{});assert.equal(calls,2);assert.equal(out.materials[0].quantity,'100');assert.equal(out.materials[0].price_jpy,'');assert.ok(out.missing.length);}finally{global.fetch=original;}
});
test('transport failure stops immediately, invalid shape permits one bounded repair',async()=>{
 const original=global.fetch;let calls=0;global.fetch=async()=>{calls++;if(calls===1)throw new TypeError('network');return Response.json({choices:[{message:{content:JSON.stringify(draft)}}]});};
 try{await assert.rejects(voiceRecipeModel('k','s',{},new AbortController().signal,{}),e=>e.code==='provider_unavailable');assert.equal(calls,1);calls=0;global.fetch=async()=>{calls++;return Response.json({});};await assert.rejects(voiceRecipeModel('k','s',{},new AbortController().signal,{}),e=>e.code==='invalid_response');assert.equal(calls,2);}finally{global.fetch=original;}
});
test('user cancellation never retries',async()=>{const c=new AbortController();c.abort();await assert.rejects(voiceRecipeModel('k','s',{},c.signal,{}),e=>e.code==='cancelled');});
const {prepareRecipeTurns}=require('../recipe-turns.ts');
test('more than thirty failed initial fragments are packed without losing the first or last turn',()=>{const turns=Array.from({length:50},(_,n)=>'食材'+n);const packed=prepareRecipeTurns(turns);assert.ok(packed.length<=30);assert.equal(packed.join('\n'),turns.join('\n'));});
test('timeouts are bounded and distinct from user cancellation during a request',async()=>{
 const original=global.fetch,timeout=AbortSignal.timeout;let calls=0;
 AbortSignal.timeout=()=>timeout(2);
 global.fetch=async(_,init)=>{calls++;return new Promise((_,reject)=>{init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});});};
 const keepAlive=setInterval(()=>{},100);
 try{await assert.rejects(voiceRecipeModel('k','s',{},new AbortController().signal,{}),e=>e.code==='timeout');assert.equal(calls,1);calls=0;const c=new AbortController();setTimeout(()=>c.abort(),0);await assert.rejects(voiceRecipeModel('k','s',{},c.signal,{}),e=>e.code==='cancelled');assert.equal(calls,1);}finally{clearInterval(keepAlive);global.fetch=original;AbortSignal.timeout=timeout;}
});
test('numeric units are regenerated rather than invented as unit symbols',()=>{assert.equal(normalizedDraft({...draft,materials:[{...draft.materials[0],unit:100}]}),null);});
test('continuous transcript reaches Muse as one string with the current draft and latest correction',async()=>{
 Object.assign(process.env,{MODEL_API_KEY:'fixture',DEMO_PREVIEW_PASSWORD:'test-only-preview-password-32-characters'});
 const original=global.fetch;let sent;
 global.fetch=async(_,init)=>{sent=JSON.parse(init.body);return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(draft)}}]});};
 const transcript='パスタ100g\n鶏卵一個\n三十五円\n鶏卵は三十円に訂正';
 try{const r=await POST(new NextRequest('http://localhost/api/voice-recipe',{method:'POST',headers:{origin:'http://localhost',authorization:'Basic '+Buffer.from('chef:'+process.env.DEMO_PREVIEW_PASSWORD).toString('base64')},body:JSON.stringify({transcript:'鶏卵は三十円に訂正',history:'パスタ100g\n鶏卵一個\n三十五円',previous:draft,defer_prices:true})}));assert.equal(r.status,200);const input=JSON.parse(sent.messages[1].content);assert.equal(input.conversation_transcript,transcript);assert.equal(input.new_turns,'鶏卵は三十円に訂正');assert.equal(input.previous_draft.title,draft.title);}finally{global.fetch=original;}
});

const {recipeRequestBatch}=require('../recipe-turns.ts');
test('UTF-8 body limits preserve every pending fragment without duplicate text',()=>{
 for(const size of [12,35,80]){
  const turns=Array.from({length:size},(_,i)=>String(i)+'卵'.repeat(898));let offset=0;const recovered=[];
  while(offset<turns.length){const {body,count}=recipeRequestBatch(turns,offset,offset?draft:null);assert.ok(Buffer.byteLength(JSON.stringify(body))<=64000);assert.ok(body.transcript.length<=30000);assert.equal(body.turns,undefined);recovered.push(body.transcript);offset+=count;}
  assert.equal(recovered.join('\n'),turns.join('\n'));
 }
 const old=Array(40).fill('卵'.repeat(900));const {body,count}=recipeRequestBatch([...old,'卵は30円'],40,draft);assert.equal(count,1);assert.equal(body.transcript,'卵は30円');assert.equal(body.history,undefined);assert.equal(body.previous,draft);
});
test('review example of twelve 900-character Japanese fragments is accepted by the real route',async()=>{
 Object.assign(process.env,{MODEL_API_KEY:'fixture',DEMO_PREVIEW_PASSWORD:'test-only-preview-password-32-characters'});
 const original=global.fetch;global.fetch=async()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(draft)}}]});
 try{const {body,count}=recipeRequestBatch(Array(12).fill('卵'.repeat(900)),0,null);assert.equal(count,12);const r=await POST(new NextRequest('http://localhost/api/voice-recipe',{method:'POST',headers:{origin:'http://localhost',authorization:'Basic '+Buffer.from('chef:'+process.env.DEMO_PREVIEW_PASSWORD).toString('base64')},body:JSON.stringify(body)}));assert.equal(r.status,200);}finally{global.fetch=original;}
});
