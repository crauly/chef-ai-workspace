import {NextRequest,NextResponse} from "next/server";
import {previewAuthorized} from "../../../preview-access";
const answer=(status:string,code=200)=>NextResponse.json({status},{status:code,headers:{"Cache-Control":"no-store"}});
export async function POST(req:NextRequest) {
  if(!await previewAuthorized(req))return answer("not_authorized",403);
  if(req.headers.get("origin")!==req.nextUrl.origin)return answer("origin_rejected",403);
  const token=process.env.DEMO_ACCESS_TOKEN;
  if(!token)return answer("proxy_not_configured",503);
  try {
    const upstream=await fetch(new URL("/api/meta_runtime",req.nextUrl.origin),{
      method:"POST",
      headers:{"X-Demo-Access":token,"Content-Type":"application/json"},
      body:JSON.stringify({model:"muse-spark-1.3"}),
      redirect:"error",cache:"no-store",signal:AbortSignal.timeout(27000)
    });
    if(!upstream.ok)return answer(upstream.status===404?"python_route_not_found":"python_runtime_error",502);
    const result:unknown=await upstream.json();
    const status=result&&typeof result==="object"?(result as {status?:unknown}).status:null;
    const reason=result&&typeof result==="object"?(result as {reason?:unknown}).reason:null;
    const statuses=["missing_vercel_model_key","inference_ready","invalid_response","request_rejected","unauthorized","forbidden","model_unavailable","rate_limited","provider_error","transport_or_parse_error"];
    if(typeof status!=="string"||!statuses.includes(status))return answer("invalid_python_result",502);
    return NextResponse.json({status,reason:reason==="model_not_found"?"model_not_found":"unspecified"},{headers:{"Cache-Control":"no-store"}});
  }catch{return answer("proxy_transport_error",502);}
}
