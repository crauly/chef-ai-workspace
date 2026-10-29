import {NextRequest, NextResponse} from "next/server";
import {previewAuthorized} from "../../../preview-access";

export const runtime = "nodejs";
const fail=(code:number)=>NextResponse.json({error:"Voice command failed"},{status:code,headers:{"Cache-Control":"no-store"}});
const INSTRUCTION = [
  "Classify a professional chef's spoken navigation instruction in Japanese or English.",
  "Understand natural paraphrases and self-corrections, not only exact keywords.",
  "Return ONLY a JSON object with exactly two keys: intent and target.",
  "intent must be one of create, browse, edit, clarify.",
  "target is the explicitly named recipe, or an empty string if not specified.",
  "Create starts a new recipe; browse searches or views a recipe; edit modifies the selected recipe.",
  "If unclear, conflicting or garbled, choose clarify.",
  "Questions about existing data, thanks, or negated editing do not request a modification; use browse or clarify, never edit.",
  "Never save, delete, approve, modify data or authorize any operation."
].join(" ");

export async function POST(req:NextRequest) {
  if(!await previewAuthorized(req))return fail(403);
  if(req.headers.get("origin")!==req.nextUrl.origin)return fail(403);
  const key=process.env.MODEL_API_KEY;
  if(!key)return fail(503);
  try {
    const body=await req.text();
    if(new TextEncoder().encode(body).length>4096)return fail(413);
    const parsed:unknown=JSON.parse(body);
    if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))return fail(400);
    const record=parsed as Record<string,unknown>;
    if(typeof record.utterance!=="string"||!record.utterance.trim()||record.utterance.length>1000||
      !["idle","create","browse","edit"].includes(String(record.current_mode)))return fail(400);

    const upstream=await fetch("https://api.meta.ai/v1/chat/completions",{
      method:"POST",
      headers:{"Authorization":"Bearer "+key,"Content-Type":"application/json"},
      body:JSON.stringify({
        model:"muse-spark-1.3",
        reasoning_effort:"low",max_completion_tokens:2048,
        messages:[
          {role:"system",content:INSTRUCTION},
          {role:"user",content:JSON.stringify({utterance:record.utterance,current_mode:record.current_mode})}
        ]
      }),
      redirect:"error",cache:"no-store",signal:AbortSignal.timeout(22000)
    });
    if(!upstream.ok)return fail(502);
    const raw=await upstream.text();
    if(new TextEncoder().encode(raw).length>32768)return fail(502);
    const response:unknown=JSON.parse(raw);
    const choices=response&&typeof response==="object"?(response as {choices?:unknown}).choices:null;
    if(!Array.isArray(choices)||choices.length!==1)return fail(502);
    const first:unknown=choices[0];
    const message=first&&typeof first==="object"?(first as {message?:unknown}).message:null;
    const content=message&&typeof message==="object"?(message as {content?:unknown}).content:null;
    if(typeof content!=="string")return fail(502);
    const result:unknown=JSON.parse(content);
    if(!result||typeof result!=="object"||Array.isArray(result))return fail(502);
    const intent=result as Record<string,unknown>;
    if(Object.keys(intent).length!==2||!Object.hasOwn(intent,"intent")||!Object.hasOwn(intent,"target")||
      !["create","browse","edit","clarify"].includes(String(intent.intent))||
      typeof intent.target!=="string"||intent.target.length>200)return fail(502);
    return NextResponse.json({intent:intent.intent,target:intent.target},{headers:{"Cache-Control":"no-store"}});
  }catch{return fail(502);}
}
