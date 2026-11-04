import {NextRequest,NextResponse} from 'next/server';
import {timingSafeEqual} from 'node:crypto';
import {backendUrl} from '../../backend-url';
import {runScheduledResearch} from '../../../../scheduled-price-research';
export const maxDuration=60;
export const dynamic='force-dynamic';
export async function GET(req:NextRequest){
 const secret=process.env.CRON_SECRET,auth=req.headers.get('authorization')??'';
 const expected='Bearer '+secret;const incoming=Buffer.from(auth),required=Buffer.from(expected);
 if(!secret||secret.length<32||incoming.length!==required.length||!timingSafeEqual(incoming,required))return NextResponse.json({error:'forbidden'},{status:403});
 const base=backendUrl(),token=process.env.DEMO_ACCESS_TOKEN,key=process.env.MODEL_API_KEY;
 if(!base||!token||!key)return NextResponse.json({error:'unavailable'},{status:503});
 try{
  const results=await runScheduledResearch(async(action,payload)=>{
   const response=await fetch(new URL('/demo/price-research/'+action,base),{method:'POST',headers:{'X-Demo-Access':token,'Content-Type':'application/json'},body:JSON.stringify(payload??{}),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});
   if(!response.ok)throw new Error('backend');return response.json();
  },key);
  return NextResponse.json({processed:results.length,failed:results.filter(r=>r.status==='rejected').length},{headers:{'Cache-Control':'no-store'}});
 }catch{return NextResponse.json({error:'research_failed'},{status:503});}
}
