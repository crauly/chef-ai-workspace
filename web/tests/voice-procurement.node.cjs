require('./ts-require.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {toSaveMaterials}=require('../app/VoiceRecipeRegistration.tsx');
const material={name:'パスタ',quantity:'100',unit:'g',price_jpy:'350',price_quantity:'500',price_unit:'g',supplier:' Amazon '};
test('approved projection preserves supplier and the complete purchase tuple',()=>{
 const [saved]=toSaveMaterials({materials:[material]});
 assert.deepEqual(saved,{name:'パスタ',quantity:'100',unit:'g',supplier:'Amazon',price_jpy:'350',price_quantity:'500',price_unit:'g'});
});
test('an incomplete purchase tuple remains unresolved without dropping the supplier',()=>{
 const [saved]=toSaveMaterials({materials:[{...material,price_quantity:''}]});
 assert.equal(saved.supplier,'Amazon');assert.equal(saved.quantity,'100');
 assert.equal(saved.price_jpy,null);assert.equal(saved.price_quantity,null);assert.equal(saved.price_unit,null);
});
test('unspecified supplier is sent as null for server-side abstract supplier resolution',()=>{
 const [saved]=toSaveMaterials({materials:[{...material,supplier:''}]});assert.equal(saved.supplier,null);assert.equal(saved.price_jpy,'350');
});
test('known purchase facts survive unknown recipe usage; invalid nullable values never reach the API',()=>{
 const {draftNumber,registrationIssues,parseRecipeDraft}=require('../recipe-draft-parse.ts');
 assert.equal(draftNumber('１，２００.００'),'1200');assert.equal(draftNumber('1e-30',true),'1e-30');assert.equal(draftNumber('0',true),null);assert.equal(draftNumber('1e131072'),null);
 const parsed=parseRecipeDraft({title:'料理',materials:[{...material,quantity:'',unit:'',price_jpy:'３５０',price_quantity:'５００',price_unit:'g'}],notes:[],selling_price_jpy:''});
 const [saved]=toSaveMaterials(parsed);assert.equal(saved.quantity,null);assert.equal(saved.unit,null);assert.equal(saved.price_jpy,'350');assert.equal(saved.price_quantity,'500');
 const bad={...material,quantity:'-2',price_quantity:'0',unit:'x'.repeat(33)};
 assert.equal(toSaveMaterials({materials:[bad]})[0].quantity,null);assert.equal(toSaveMaterials({materials:[bad]})[0].price_jpy,null);
 assert(registrationIssues({title:'料理',materials:[bad],selling_price_jpy:'0'}).some(i=>i.path==='selling_price_jpy'));
 assert.equal(bad.price_jpy,'350'); // No changes to the retained draft facts.
});
test('registration errors distinguish input, conflict, service and uncertain transport failures',()=>{
 const {registrationError}=require('../app/VoiceRecipeRegistration.tsx');
 assert.match(registrationError({message:'422',issues:[{path:'materials.0.quantity',reason:'invalid'}]},true),/materials\.0\.quantity/);
 assert.match(registrationError(new Error('409'),true),/競合/);assert.match(registrationError(new Error('503'),true),/サービス障害/);assert.match(registrationError(new TypeError('fetch failed'),true),/結果未確認/);
});
test('full-recipe proxy carries safe field paths through request errors without exposing input',async()=>{
 const {NextRequest}=require('next/server');const {forward}=require('../app/api/proxy.ts');const {request}=require('../app/types.ts');const {registrationError}=require('../app/VoiceRecipeRegistration.tsx');
 const oldFetch=global.fetch,env={...process.env};Object.assign(process.env,{DEMO_PREVIEW_PASSWORD:'test-only-preview-password-32-characters',FASTAPI_BASE_URL:'http://localhost:8100',DEMO_ACCESS_TOKEN:'test'});
 try{
  global.fetch=async()=>Response.json({detail:[{loc:['body','materials',0,'quantity'],type:'string_too_long',input:'secret',msg:'secret internal data'}]},{status:422});
  const r=await forward(new NextRequest('http://localhost/api/recipes/full/review',{method:'POST',headers:{Origin:'http://localhost',authorization:'Basic '+Buffer.from('chef:'+process.env.DEMO_PREVIEW_PASSWORD).toString('base64')},body:'{}'}),undefined,'/full/review');
  const body=await r.json();assert.equal(r.status,422);assert.equal(body.issues[0].path,'materials.0.quantity');assert(!JSON.stringify(body).includes('secret'));
  global.fetch=async()=>Response.json(body,{status:422});await assert.rejects(request('/api/recipes/full/review'),e=>/materials\.0\.quantity/.test(registrationError(e,true)));
 }finally{global.fetch=oldFetch;for(const k of Object.keys(process.env))if(!(k in env))delete process.env[k];Object.assign(process.env,env);}
});
test('NFKC material normalization keeps name-correction references bound to their row',()=>{
 const {parseRecipeDraft}=require('../recipe-draft-parse.ts');
 const result=parseRecipeDraft({title:'料理',materials:[{...material,name:' ｼﾒｼﾞ '}],selling_price_jpy:'',notes:[],name_corrections:[{material_name:' ｼﾒｼﾞ ',heard:'ｼﾒｼﾞ',candidates:[{name:'しめじ',reason:'確認候補'}]}]});
 const correction=result.nameCorrections[0];assert.equal(correction.material_name,'シメジ');assert.equal(result.materials.findIndex(m=>m.name===correction.material_name),0);assert.equal(correction.heard,'ｼﾒｼﾞ');assert.equal(correction.candidates[0].name,'しめじ');
});
test('supplier target in a price preview is independent of operation order',()=>{
 const {describe}=require('../app/AIEditor.tsx');
 const recipe={id:'recipe',title:{value:'料理'},revision:0,selling_price_jpy:{value:null},materials:[{id:'line',material_name:{value:'食材'},quantity:{value:'10'},unit:'g',price_mode:'inherit',supplier_id:'old',supplier_name:'旧仕入先',effective_price:{amount_jpy:{value:'300'},per_quantity:'1',per_unit:'kg'}}]};
 const result=describe(recipe,[{op:'set_material_price',material_id:'line',price_jpy:'500',price_quantity:'1',price_unit:'kg'},{op:'set_material_supplier',material_id:'line',supplier_id:'new'}],'ja',{new:'東京市場'});
 assert.match(result.changes.find(s=>s.includes('¥500')),/東京市場/);
});
