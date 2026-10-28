import {NextRequest,NextResponse} from "next/server";
import {previewAuthorized} from "../../../preview-access";

export const runtime = "nodejs";
function report(status:string, httpStatus=200, reason="unspecified") {
  return NextResponse.json({status,reason},{status:httpStatus,headers:{"Cache-Control":"no-store"}});
}
export async function POST(req:NextRequest) {
  if(!await previewAuthorized(req))return report("not_authorized",403);
  if(req.headers.get("origin")!==req.nextUrl.origin)return report("origin_rejected",403);
  const key=process.env.MODEL_API_KEY;
  if(!key)return report("missing_vercel_model_key");
  try {
    const upstream=await fetch("https://api.meta.ai/v1/chat/completions",{
      method:"POST",
      headers:{"Authorization":"Bearer "+key,"Content-Type":"application/json"},
      body:JSON.stringify({model:"muse-spark-1.3",messages:[{role:"user",content:"Say ready"}]}),
      redirect:"error",cache:"no-store",signal:AbortSignal.timeout(24000)
    });
    const body:unknown=await upstream.json().catch(()=>null);
    if(!upstream.ok){
      const error=body&&typeof body==="object"?(body as {error?:unknown}).error:null;
      const code=error&&typeof error==="object"?(error as {code?:unknown}).code:null;
      const reason=code==="model_not_found"?"model_not_found":"unspecified";
      const status:Record<number,string>={400:"request_rejected",401:"unauthorized",403:"forbidden",404:"model_unavailable",429:"rate_limited"};
      return report(status[upstream.status]??"provider_error",200,reason);
    }
    const choices=body&&typeof body==="object"?(body as {choices?:unknown}).choices:null;
    const choice=Array.isArray(choices)&&choices.length===1?choices[0]:null;
    const message=choice&&typeof choice==="object"?(choice as {message?:unknown}).message:null;
    const content=message&&typeof message==="object"?(message as {content?:unknown}).content:null;
    return report(typeof content==="string"&&content.trim().length>0?"inference_ready":"invalid_response");
  } catch {return report("transport_or_parse_error");}
}
