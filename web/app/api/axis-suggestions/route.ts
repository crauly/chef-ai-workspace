import {NextRequest,NextResponse} from "next/server";
import {previewAuthorized} from "../../../preview-access";
const fail=(status:number)=>NextResponse.json({error:"axis_suggestions_unavailable"},{status,headers:{"Cache-Control":"no-store"}});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function GET(req:NextRequest){
 if(!await previewAuthorized(req))return fail(403);
 const base=process.env.FASTAPI_BASE_URL,token=process.env.DEMO_ACCESS_TOKEN;
 if(!base||!token)return fail(503);
 const ingredientId=req.nextUrl.searchParams.get("ingredient_id")||"";
 if(!uuid.test(ingredientId))return fail(400);
 const maxCandidates=req.nextUrl.searchParams.get("max_candidates")||"3";
 const useMuse=req.nextUrl.searchParams.get("use_muse")||"true";
 if(!/^[1-5]$/.test(maxCandidates))return fail(400);
 if(useMuse!=="true"&&useMuse!=="false")return fail(400);
 try{
  const url=new URL(base);
  if(url.protocol!=="https:"&&!(url.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(url.hostname)))return fail(503);
  const target=new URL(`/demo/ingredients/${ingredientId}/axis-suggestions`,url);
  target.searchParams.set("max_candidates",maxCandidates);
  target.searchParams.set("use_muse",useMuse);
  const response=await fetch(target,{headers:{"X-Demo-Access":token},cache:"no-store",redirect:"error",signal:AbortSignal.timeout(45000)});
  if(!response.ok)return fail(response.status>=400&&response.status<600?response.status:502);
  const data:unknown=await response.json();
  if(!data||typeof data!=="object"||typeof (data as {axes?:unknown}).axes!=="object")return fail(502);
  return NextResponse.json(data,{headers:{"Cache-Control":"no-store"}});
 }catch{return fail(502);}
}
