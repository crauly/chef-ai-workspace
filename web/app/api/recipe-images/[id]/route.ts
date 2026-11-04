import {NextRequest,NextResponse} from "next/server";
import {previewAuthorized,sameOrigin} from "../../../../preview-access";
import {backendUrl} from "../../backend-url";
export const runtime="nodejs";
const uuid=/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const fail=(status:number)=>NextResponse.json({error:"Recipe image unavailable"},{status,headers:{"Cache-Control":"no-store"}});
// Both reads and explicit writes use the same operator-verified backend owner.
// No browser service-role credentials, public bucket, or client owner IDs.
async function proxy(req:NextRequest,id:string){
 if(!await previewAuthorized(req))return fail(403);
 if(!uuid.test(id))return fail(400);
 if(req.method==="POST"&&!sameOrigin(req))return fail(403);
 const origin=backendUrl(),token=process.env.DEMO_ACCESS_TOKEN;
 if(!origin||!token)return fail(503);
 try{
  const body=req.method==="POST"?await req.text():undefined;
  if(body&&new TextEncoder().encode(body).byteLength>5600000)return fail(413);
  const response=await fetch(new URL("/demo/recipes/"+encodeURIComponent(id)+"/dish-image",origin),{
   method:req.method,headers:{"X-Demo-Access":token,"Content-Type":"application/json"},
   body,cache:"no-store",redirect:"error",signal:AbortSignal.timeout(30000)});
  if(!response.ok)return fail(response.status>=400&&response.status<=599?response.status:502);
  return NextResponse.json(await response.json(),{headers:{"Cache-Control":"private, no-store"}});
 }catch{return fail(502);}
}
export async function GET(req:NextRequest,{params}:{params:Promise<{id:string}>}){
 return proxy(req,(await params).id);
}
export async function POST(req:NextRequest,{params}:{params:Promise<{id:string}>}){
 return proxy(req,(await params).id);
}
