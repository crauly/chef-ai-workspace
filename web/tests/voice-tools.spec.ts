import {test,expect} from '@playwright/test';
import {NextRequest} from 'next/server';
import {POST as register} from '../app/api/voice-recipe/route';
import {POST as intent} from '../app/api/intent/route';
import {voiceInput} from './voice-input';
const password='test-only-preview-password-32-characters';
const id='11111111-1111-4111-8111-111111111111';
test('ordinary voice uses tool results for drafting and browsing, then reviews edits before saving',async({page,request})=>{
 await request.post('http://127.0.0.1:8100/test/reset');
 Object.assign(process.env,{MODEL_API_KEY:'fixture',FASTAPI_BASE_URL:'http://127.0.0.1:8100',DEMO_ACCESS_TOKEN:'test-only-backend-token',DEMO_PREVIEW_PASSWORD:password});
 const original=global.fetch;const tools:string[]=[];let parses=0,saves=0;
 global.fetch=async(url,init)=>{
  if(!String(url).includes('api.meta.ai'))return original(url,init);
  const body=JSON.parse(String(init?.body)),name=body.response_format.json_schema.name;
  const replies=body.messages.filter((m:any)=>m.role==='tool');
  const tool=(toolName:string,args:object)=>{tools.push(toolName);return Response.json({choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:'call_'+replies.length,type:'function',function:{name:toolName,arguments:JSON.stringify(args)}}]}}]});};
  if(!replies.length)return tool('search_recipes',{query:'片栗粉'});
  if(name==='chef_voice_recipe'&&replies.length===1)return tool('get_recipe',{recipe_id:id});
  const result=name==='chef_intent'?{intent:'browse',target:'片栗粉のレシピ'}:{title:'参考パスタ',materials:[{name:'片栗粉',quantity:JSON.parse(replies[1].content).materials[0].quantity.value,unit:'g',price_jpy:'',price_quantity:'',price_unit:'',supplier:''}],selling_price_jpy:'',notes:[],interpretations:[],price_research:[],unit_proposals:[],name_corrections:[],material_changes:[]};
  return Response.json({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(result)}}]});
 };
 // Invoke actual Next handlers and tool executors; only external Meta inference
 // is mocked. Their owned reads use the same fixture backend as the browser.
 for(const [path,handler] of [['voice-recipe',register],['intent',intent]] as const){
  await page.route('**/api/'+path,async route=>{
   if(path==='voice-recipe')parses++;
   const res=await handler(new NextRequest('http://localhost/api/'+path,{method:'POST',headers:{origin:'http://localhost',authorization:'Basic '+Buffer.from('chef:'+password).toString('base64')},body:route.request().postData()}));
   await route.fulfill({status:res.status,body:await res.text(),contentType:'application/json'});
  });
 }
 page.on('request',r=>{if(r.url().endsWith('/recipes/full'))saves++;});
 try{
  await page.goto('/');await voiceInput(page,'片栗粉と同じ分量で参考パスタを作ります');expect(parses).toBe(0);
  await voiceInput(page,'内容を確認');await expect(page.getByLabel('未保存のレシピ下書き')).toContainText('参考パスタ');expect(tools).toEqual(['search_recipes','get_recipe']);expect(saves).toBe(0);
  await voiceInput(page,'保存');await expect.poll(()=>saves).toBe(1);await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]+$/);
  await voiceInput(page,'片栗粉のレシピを開いて');await expect(page.getByRole('heading',{name:'片栗粉のレシピ',exact:true})).toBeVisible();expect(tools).toEqual(['search_recipes','get_recipe','search_recipes']);
  await voiceInput(page,'片栗粉を15gに変更');await expect(page.getByRole('dialog',{name:'変更案の確認'})).toBeVisible();
  expect((await (await request.get('http://127.0.0.1:8100/test/state')).json()).confirms).toHaveLength(0);
  await voiceInput(page,'承認して保存');await expect(page.getByRole('dialog',{name:'変更案の確認'})).toHaveCount(0);
  expect((await (await request.get('http://127.0.0.1:8100/test/state')).json()).confirms).toHaveLength(1);
 }finally{global.fetch=original;}
});
