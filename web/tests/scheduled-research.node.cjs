require('./ts-require.cjs');
const {test}=require('node:test');const assert=require('node:assert/strict');
const {runScheduledResearch}=require('../scheduled-price-research.ts');
const {GET}=require('../app/api/cron/price-research/route.ts');
const {NextRequest}=require('next/server');
const job=n=>({ingredient_id:'i'+n,token:'t'+n,name:'食材'+n,brand:'メーカー',spec:'500g'});
test('no eligible jobs means no model call or writes',async()=>{let searches=0;await runScheduledResearch(async()=>[],'k',async()=>{searches++;});assert.equal(searches,0);});
test('one failure does not lose other jobs; only a sourced raw JPY quote is recorded',async()=>{
 const finishes=[];let call=0;
 const result=await runScheduledResearch(async(action,payload)=>{if(action==='claim')return [job(1),job(2),job(3)];finishes.push(payload);return {};},'k',async args=>{
  assert.match(args.materialName,/メーカー 500g/);call++;if(call===1)throw new Error('network');if(call===2)return {kind:'timeout'};
  return {kind:'found',entry:{currency:'JPY',samples:[{name:'食材3',amount:'350',package_quantity:'500',package_unit:'g',url:'https://shop.example/item',seller:'店舗'}]}};
 });
 assert.equal(result.length,3);assert.equal(finishes.length,3);assert.equal(finishes.filter(f=>f.candidate).length,1);assert.equal(finishes.find(f=>f.candidate).candidate.amount,'350');
 assert.ok(finishes.every(f=>!('confirmed' in f)&&!('adopted_observation_id' in f)));
});
test('citation-free sample never creates a price candidate',async()=>{let finish;await runScheduledResearch(async(a,p)=>a==='claim'?[job(1)]:(finish=p),'k',async()=>({kind:'found',entry:{currency:'JPY',samples:[{amount:'100',package_quantity:'1',package_unit:'kg'}]}}));assert.equal(finish.candidate,null);});
test('cron authentication fails closed including non-ASCII headers',async()=>{
 process.env.CRON_SECRET='x'.repeat(40);
 for(const auth of ['', 'Bearer '+'y'.repeat(40),'Bearer '+'é'.repeat(40)]){const req=new NextRequest('https://chef.example/api/cron/price-research',{headers:{authorization:auth}});assert.equal((await GET(req)).status,403);}
});
