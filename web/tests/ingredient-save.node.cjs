require('./ts-require.cjs');
const {test}=require('node:test'),assert=require('node:assert/strict');
const {NextRequest}=require('next/server');const {PUT}=require('../app/api/ingredients/[id]/route.ts');
const {ingredientSaveCodes,ingredientSaveMessage}=require('../ingredient-save-contract.ts');
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function req(){return new NextRequest('http://localhost/api/ingredients/'+id,{method:'PUT',headers:{origin:'http://localhost',authorization:'Basic '+Buffer.from('chef:'+process.env.DEMO_PREVIEW_PASSWORD).toString('base64')},body:JSON.stringify({request_id:id,name:'パスタ',purchase:null})});}
test('ingredient edit forwards one atomic request and only allowlisted error codes',async()=>{
 const env={...process.env},old=global.fetch;
 Object.assign(process.env,{DEMO_PREVIEW_PASSWORD:'test-only-preview-password-32-characters',FASTAPI_BASE_URL:'http://localhost:8100',DEMO_ACCESS_TOKEN:'test'});
 try{
  for(const code of ingredientSaveCodes){let calls=0;global.fetch=async(url,init)=>{calls++;assert.equal(String(url),'http://localhost:8100/demo/ingredients/'+id);assert.equal(init.method,'PUT');return Response.json({error:code,internal:'secret database detail'},{status:422});};
   const r=await PUT(req(),{params:Promise.resolve({id})});assert.deepEqual(await r.json(),{error:code});assert.equal(calls,1);assert(ingredientSaveMessage(code,true).length>0);
  }
  global.fetch=async()=>Response.json({error:'SQL secret detail'},{status:500});
  assert.deepEqual(await (await PUT(req(),{params:Promise.resolve({id})})).json(),{error:'database_error'});
  global.fetch=async()=>{throw new Error('private network address');};
  assert.deepEqual(await (await PUT(req(),{params:Promise.resolve({id})})).json(),{error:'api_unavailable'});
 }finally{global.fetch=old;for(const k of Object.keys(process.env))if(!(k in env))delete process.env[k];Object.assign(process.env,env);}
});
