import {NextRequest, NextResponse} from "next/server";
import {previewAuthorized} from "../../../preview-access";
export const runtime="nodejs";
// Block 3 (ADR-014): text-to-image for a dish illustration (Muse Image).
// Single-shot POST /v1/images/generations, model muse-image-1.0, n=1.
// The API key stays server-side; the browser only sends a short prompt and
// receives a preview image (data URL or temporary URL). No persistence, no
// save path, no draft mutation: failures return an error code and the caller
// keeps its draft. This is NOT Image Understanding (photo -> proposal): the
// result is an illustration, never evidence for quantity/price/real photo.
const error=(status:number,code:string)=>NextResponse.json({error:"Dish image generation failed",code},{status,headers:{"Cache-Control":"no-store"}});
export async function POST(req:NextRequest){
 if(!await previewAuthorized(req))return error(403,"forbidden");
 if(req.headers.get("origin")!==req.nextUrl.origin)return error(403,"forbidden");
 const key=process.env.MODEL_API_KEY;if(!key)return error(503,"unavailable");
 let input:unknown;try{input=JSON.parse(await req.text());}catch{return error(400,"invalid_prompt");}
 const prompt=input&&typeof input==="object"?(input as {prompt?:unknown}).prompt:null;
 if(typeof prompt!=="string"||!prompt.trim()||prompt.trim().length>500)return error(400,"invalid_prompt");
 try{
  const upstream=await fetch("https://api.meta.ai/v1/images/generations",{method:"POST",
   headers:{"Authorization":"Bearer "+key,"Content-Type":"application/json"},
   body:JSON.stringify({model:"muse-image-1.0",prompt:prompt.trim(),n:1}),
   cache:"no-store",redirect:"error",signal:AbortSignal.any([req.signal,AbortSignal.timeout(60000)])});
  if(!upstream.ok){console.error(`dish-image stage=upstream status=${upstream.status}`);return error(502,"upstream_error");}
  const raw=await upstream.text();
  if(raw.length>12*1024*1024){console.error("dish-image stage=body_size");return error(502,"bad_response");}
  let data:unknown;try{data=JSON.parse(raw);}catch{console.error("dish-image stage=upstream_json");return error(502,"bad_response");}
  const entries=data&&typeof data==="object"&&Array.isArray((data as {data?:unknown}).data)?(data as {data:unknown[];output_format?:unknown}).data:[];
  const first=entries.length===1?entries[0]:null;
  const format=data&&typeof data==="object"?String((data as {output_format?:unknown}).output_format??"png"):"png";
  const mime=format==="jpeg"?"image/jpeg":format==="webp"?"image/webp":"image/png";
  if(first&&typeof first==="object"){
   const rec=first as {b64_json?:unknown;url?:unknown};
   if(typeof rec.b64_json==="string"&&rec.b64_json.length>0)
    return NextResponse.json({image:`data:${mime};base64,${rec.b64_json}`,output_format:format},{headers:{"Cache-Control":"no-store"}});
   if(typeof rec.url==="string"&&rec.url.length>0)
    return NextResponse.json({image:rec.url,output_format:format},{headers:{"Cache-Control":"no-store"}});
  }
  console.error("dish-image stage=content_shape");return error(502,"bad_response");
 }catch(err){
  if(err&&typeof err==="object"&&"name" in err&&(err as {name?:string}).name==="TimeoutError"){console.error("dish-image stage=timeout");return error(504,"timeout");}
  if(req.signal.aborted)throw err;
  console.error("dish-image stage=transport");return error(502,"upstream_error");
 }
}
