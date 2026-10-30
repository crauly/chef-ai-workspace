import {NextRequest,NextResponse} from "next/server";
import {previewAuthorized} from "../../../../preview-access";
const fail=(status:number)=>NextResponse.json({error:"notifications_unavailable"},{status,headers:{"Cache-Control":"no-store"}});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function backend(){const base=process.env.FASTAPI_BASE_URL,token=process.env.DEMO_ACCESS_TOKEN;
 if(!base||!token)return undefined;
 const url=new URL(base);
 if(url.protocol!=="https:"&&!(url.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(url.hostname)))return undefined;
 return {url,token};}
export async function GET(req:NextRequest,{params}:{params:Promise<{id:string}>}){
 if(!await previewAuthorized(req))return fail(403);
 const {id}=await params;
 if(!uuid.test(id))return fail(400);
 const b=await backend();if(!b)return fail(503);
 try{
  const response=await fetch(new URL(`/demo/notifications/${id}`,b.url),{
   headers:{"X-Demo-Access":b.token},cache:"no-store",redirect:"error",signal:AbortSignal.timeout(20000)});
  if(!response.ok)return fail(response.status>=400&&response.status<600?response.status:502);
  return NextResponse.json(await response.json(),{headers:{"Cache-Control":"no-store"}});
 }catch{return fail(502);}
}
export async function PATCH(req:NextRequest,{params}:{params:Promise<{id:string}>}){
 if(!await previewAuthorized(req))return fail(403);
 if(req.headers.get("origin")!==req.nextUrl.origin)return fail(403);
 const {id}=await params;
 if(!uuid.test(id))return fail(400);
 let status:unknown;
 try{status=(await req.json() as {status?:unknown}).status;}catch{return fail(400);}
 if(status!=="unread"&&status!=="acknowledged"&&status!=="resolved")return fail(400);
 const b=await backend();if(!b)return fail(503);
 try{
  const response=await fetch(new URL(`/demo/notifications/${id}`,b.url),{
   method:"PATCH",headers:{"X-Demo-Access":b.token,"Content-Type":"application/json"},
   body:JSON.stringify({status}),cache:"no-store",redirect:"error",signal:AbortSignal.timeout(20000)});
  if(response.status===422)return NextResponse.json({error:"invalid_transition"},{status:422,headers:{"Cache-Control":"no-store"}});
  if(!response.ok)return fail(response.status>=400&&response.status<600?response.status:502);
  return NextResponse.json(await response.json(),{headers:{"Cache-Control":"no-store"}});
 }catch{return fail(502);}
}
