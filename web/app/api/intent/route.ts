import {NextRequest, NextResponse} from "next/server";
import {previewAuthorized} from "../../../preview-access";
import {museConversation} from "../../../voice-recipe-provider";
import {INTENT_SCHEMA,chatResponseFormat} from "../../../muse-schemas";

export const runtime = "nodejs";
const fail=(code:number)=>NextResponse.json({error:"Voice command failed"},{status:code,headers:{"Cache-Control":"no-store"}});
const INSTRUCTION = [
  "Classify a professional chef's spoken navigation instruction in Japanese or English.",
  "Understand natural paraphrases and self-corrections, not only exact keywords.",
  "Return ONLY a JSON object with exactly two keys: intent and target.",
  "intent must be one of create, browse, edit, clarify.",
  "Use search_recipes and get_recipe when resolving references to saved recipes. target is the matching saved recipe title, or the explicitly named recipe when no lookup is needed. If ambiguous, clarify; never pick an arbitrary match.",
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

    const content=await museConversation(key,[
      {role:"developer",content:INSTRUCTION},
      {role:"user",content:JSON.stringify({utterance:record.utterance,current_mode:record.current_mode})}
    ],chatResponseFormat("chef_intent",INTENT_SCHEMA),AbortSignal.any([req.signal,AbortSignal.timeout(22000)]),2048);
    const result:unknown=JSON.parse(content);
    if(!result||typeof result!=="object"||Array.isArray(result))return fail(502);
    const intent=result as Record<string,unknown>;
    if(Object.keys(intent).length!==2||!Object.hasOwn(intent,"intent")||!Object.hasOwn(intent,"target")||
      !["create","browse","edit","clarify"].includes(String(intent.intent))||
      typeof intent.target!=="string"||intent.target.length>200)return fail(502);
    return NextResponse.json({intent:intent.intent,target:intent.target},{headers:{"Cache-Control":"no-store"}});
  }catch{return fail(502);}
}
