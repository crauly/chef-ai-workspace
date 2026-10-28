import {NextRequest,NextResponse} from "next/server";
import {previewAuthorized} from "../../../preview-access";
export const runtime="nodejs";
export async function GET(req:NextRequest){
 if(!await previewAuthorized(req))return NextResponse.json({status:"forbidden"},{status:403});
 const base=process.env.CHEF_FASTAPI_INTERNAL_URL;
 if(!base)return NextResponse.json({status:"backend_binding_missing"},{status:503});
 try{
  const res=await fetch(new URL("/health",base),{cache:"no-store",redirect:"error",signal:AbortSignal.timeout(10000)});
  const data:unknown=await res.json().catch(()=>null);
  const ok=res.ok&&!!data&&typeof data==="object"&&(data as {status?:unknown}).status==="ok";
  return NextResponse.json({status:ok?"backend_ready":"backend_unhealthy"},{status:ok?200:502,headers:{"Cache-Control":"no-store"}});
 }catch{return NextResponse.json({status:"backend_unreachable"},{status:502,headers:{"Cache-Control":"no-store"}});}
}
