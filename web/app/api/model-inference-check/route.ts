import {NextRequest, NextResponse} from "next/server";
import {previewAuthorized} from "../../../preview-access";
const response=(status:string,http=200)=>NextResponse.json({status},{status:http,headers:{"Cache-Control":"no-store"}});
export async function POST(req:NextRequest){
 if(!await previewAuthorized(req))return response("not_authorized",403);
 if(req.headers.get("origin")!==req.nextUrl.origin)return response("origin_rejected",403);
 let model="muse-spark-1.3";
 try {
  const data:unknown=await req.json();
  const candidate=data&&typeof data==="object"?(data as {model?:unknown}).model:null;
  if(typeof candidate!=="string"||!["muse-spark-1.3","muse-spark-1.2","muse-spark-1.1"].includes(candidate))return response("invalid_model",400);
  model=candidate;
 }catch{return response("invalid_request",400);}
 const base=process.env.FASTAPI_BASE_URL,token=process.env.DEMO_ACCESS_TOKEN;
 if(!base||!token)return response("proxy_not_configured",503);
 try{
  const url=new URL(base);
  if(url.protocol!=="https:"&&!(url.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(url.hostname)))return response("proxy_not_configured",503);
  const upstream=await fetch(new URL("/demo/model-inference-check",url),{
   method:"POST",headers:{"X-Demo-Access":token,"Content-Type":"application/json"},
   body:JSON.stringify({model}),redirect:"error",cache:"no-store",signal:AbortSignal.timeout(28000)
  });
  if(!upstream.ok)return response(upstream.status===404?"backend_outdated":"backend_error",502);
  const value:unknown=await upstream.json();
  const status=value&&typeof value==="object"?(value as {status?:unknown}).status:null;
  const reason=value&&typeof value==="object"?(value as {reason?:unknown}).reason:null;
  const allowed=["inference_ready","unauthorized","forbidden","model_unavailable","rate_limited","request_rejected",
   "provider_error","connection_error","invalid_response","incomplete_response","unexpected_model_output",
   "response_too_large","not_configured","unsupported_provider"];
  if(typeof status!=="string"||!allowed.includes(status))return response("invalid_backend_response",502);
  const reasons=["unspecified","model_not_found","model_access_denied","model_not_found_or_no_access","endpoint_not_found","authentication_error","permission_error"];
  return NextResponse.json({status,reason:typeof reason==="string"&&reasons.includes(reason)?reason:"unspecified"},{headers:{"Cache-Control":"no-store"}});
 }catch{return response("proxy_transport_error",502);}
}
