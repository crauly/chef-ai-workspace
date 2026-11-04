import {NextRequest,NextResponse} from 'next/server';
import {previewAuthorized,sameOrigin} from '../../../preview-access';
import {backendUrl} from '../backend-url';
export async function researchProxy(req:NextRequest,adopt=false){
 if(!await previewAuthorized(req)||(req.method!=='GET'&&!sameOrigin(req)))return NextResponse.json({error:'forbidden'},{status:403});
 const base=backendUrl(),key=process.env.DEMO_ACCESS_TOKEN;
 if(!base||!key)return NextResponse.json({error:'unavailable'},{status:503});
 try{
  const body=req.method==='GET'?undefined:await req.text();if(body&&body.length>4096)return NextResponse.json({error:'too_large'},{status:413});
  const response=await fetch(new URL('/demo/price-research'+(adopt?'/adopt':''),base),{method:req.method,body,headers:{'X-Demo-Access':key,'Content-Type':'application/json'},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok)return NextResponse.json({error:'research_failed'},{status:response.status});
  return NextResponse.json(await response.json(),{headers:{'Cache-Control':'no-store'}});
 }catch{return NextResponse.json({error:'unavailable'},{status:502});}
}
export async function GET(req:NextRequest){return researchProxy(req);}
export async function PATCH(req:NextRequest){return researchProxy(req);}
