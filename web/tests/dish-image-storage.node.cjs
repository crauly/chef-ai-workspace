require('./ts-require.cjs');
const {test,beforeEach,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const {NextRequest}=require('next/server');
const {storeDishPreview,loadDishImage}=require('../app/dish-image-cache.ts');
const proxy=require('../app/api/recipe-images/[id]/route.ts');
const ID='11111111-1111-4111-8111-111111111111';
const IMAGE='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PASSWORD='test-only-preview-password-32-characters';
let originalFetch,env,calls;
beforeEach(()=>{originalFetch=global.fetch;env={...process.env};calls=[];
 process.env.DEMO_PREVIEW_PASSWORD=PASSWORD;process.env.CHEF_FASTAPI_INTERNAL_URL='https://backend.test';process.env.DEMO_ACCESS_TOKEN='test-only-token';
 global.fetch=async(url,init={})=>{calls.push({url:String(url),init});return Response.json(init.method==='POST'?{saved:true}:{image:IMAGE});};
});
afterEach(()=>{global.fetch=originalFetch;for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);});
test('a normal recipe UUID uploads exactly once before reporting cloud persistence',async()=>{
 assert.equal(await storeDishPreview(ID,IMAGE),true);assert.equal(calls.length,1);
 assert.equal(calls[0].url,`/api/recipe-images/${ID}`);assert.equal(calls[0].init.method,'POST');assert.deepEqual(JSON.parse(calls[0].init.body),{image:IMAGE});
});
test('the same UUID loads the cloud image without using device storage',async()=>{
 assert.deepEqual(await loadDishImage(ID),{image:IMAGE,source:'cloud'});assert.equal(calls.length,1);assert.equal(calls[0].url,`/api/recipe-images/${ID}`);
});
test('the authenticated API proxy accepts the exact UUID used by the client',async()=>{
 const request=new NextRequest(`https://app.test/api/recipe-images/${ID}`,{method:'POST',headers:{origin:'https://app.test',authorization:'Basic '+Buffer.from('chef:'+PASSWORD).toString('base64')},body:JSON.stringify({image:IMAGE})});
 const response=await proxy.POST(request,{params:Promise.resolve({id:ID})});assert.equal(response.status,200);assert.equal(calls.length,1);
 assert.equal(calls[0].url,`https://backend.test/demo/recipes/${ID}/dish-image`);assert.equal(calls[0].init.headers['X-Demo-Access'],'test-only-token');
});
test('malformed IDs and invalid image data never initiate an upload or a cloud read',async()=>{
 for(const id of ['', '../recipe','11111111-1111-4111-8111-1111-111111111111']){
  assert.equal(await storeDishPreview(id,IMAGE),false);assert.deepEqual(await loadDishImage(id),{image:null,source:null});
 }
 assert.equal(await storeDishPreview(ID,'not an image'),false);assert.equal(calls.length,0);
});
