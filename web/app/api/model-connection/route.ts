import {NextRequest,NextResponse} from "next/server";
import {previewAuthorized} from "../../../preview-access";
const fail=(status:number)=>NextResponse.json({status:"proxy_error"},{status,headers:{"Cache-Control":"no-store"}});
export async function GET(req:NextRequest){
 if(!await previewAuthorized(req))return fail(403);
 const base=process.env.FASTAPI_BASE_URL,token=process.env.DEMO_ACCESS_TOKEN;
 if(!base||!token)return NextResponse.json({status:"proxy_not_configured"},{status:503});
 try {
  const url=new URL(base);
  if(url.protocol!=="https:"&&!(url.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(url.hostname)))return fail(503);
  const response=await fetch(new URL("/demo/model-connection",url),{
   headers:{"X-Demo-Access":token},cache:"no-store",redirect:"error",signal:AbortSignal.timeout(20000)
  });
  if(!response.ok)return NextResponse.json({status:response.status===404?"backend_outdated":"backend_error"},{status:502,headers:{"Cache-Control":"no-store"}});
  const data:unknown=await response.json();
  if(!data||typeof data!=="object")return fail(502);
  const status=(data as {status?:unknown}).status;
  const allowed=["ready","unauthorized","forbidden","rate_limited","provider_error","connection_error","invalid_response","model_unavailable","not_configured","unsupported_provider"];
  if(typeof status!=="string"||!allowed.includes(status))return fail(502);
  return NextResponse.json({status},{headers:{"Cache-Control":"no-store"}});
 }catch{return NextResponse.json({status:"proxy_transport_error"},{status:502});}
}
