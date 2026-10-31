import {NextRequest,NextResponse} from "next/server";
import {previewAuthorized} from "../../../preview-access";
const fail=(status:number)=>NextResponse.json({error:"notifications_unavailable"},{status,headers:{"Cache-Control":"no-store"}});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function backendBase():string|undefined{
 const internal=process.env.CHEF_FASTAPI_INTERNAL_URL;
 if(internal)return internal;
 const fallback=process.env.FASTAPI_BASE_URL;
 if(fallback&&(fallback.startsWith("http://127.0.0.1:")||fallback.startsWith("http://localhost:")))return fallback;
 return undefined;
}
function backendUrl():URL|undefined{
 const base=backendBase();
 if(!base)return undefined;
 try{
  const url=new URL(base);
  if(url.protocol!=="https:"&&!(url.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(url.hostname)))return undefined;
  if(url.username||url.password)return undefined;
  return url;
 }catch{return undefined;}
}
export async function GET(req:NextRequest){
 if(!await previewAuthorized(req))return fail(403);
 const base=backendUrl(),token=process.env.DEMO_ACCESS_TOKEN;
 if(!base||!token)return fail(503);
 try{
  const target=new URL("/demo/notifications",base);
  const status=req.nextUrl.searchParams.get("status");
  if(status&&["unread","acknowledged","resolved"].includes(status))target.searchParams.set("status",status);
  const response=await fetch(target,{headers:{"X-Demo-Access":token},cache:"no-store",redirect:"error",signal:AbortSignal.timeout(20000)});
  if(!response.ok)return fail(response.status>=400&&response.status<600?response.status:502);
  const data:unknown=await response.json();
  if(!data||typeof data!=="object"||!Array.isArray((data as {items?:unknown}).items))return fail(502);
  return NextResponse.json(data,{headers:{"Cache-Control":"no-store"}});
 }catch{return fail(502);}
}
export async function POST(req:NextRequest){
 if(!await previewAuthorized(req))return fail(403);
 if(req.headers.get("origin")!==req.nextUrl.origin)return fail(403);
 const base=backendUrl(),token=process.env.DEMO_ACCESS_TOKEN;
 if(!base||!token)return fail(503);
 let observationId:unknown;
 try{observationId=(await req.json() as {observation_id?:unknown}).observation_id;}catch{return fail(400);}
 if(typeof observationId!=="string"||!uuid.test(observationId))return fail(400);
 try{
  const response=await fetch(new URL(`/demo/observations/${observationId}/confirm`,base),{
   method:"POST",headers:{"X-Demo-Access":token},cache:"no-store",redirect:"error",signal:AbortSignal.timeout(20000)});
  if(response.status===422)return NextResponse.json({error:"not_comparable"},{status:422,headers:{"Cache-Control":"no-store"}});
  if(!response.ok)return fail(response.status>=400&&response.status<600?response.status:502);
  return NextResponse.json(await response.json(),{status:201,headers:{"Cache-Control":"no-store"}});
 }catch{return fail(502);}
}
