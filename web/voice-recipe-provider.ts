import {parseRecipeDraft} from './recipe-draft-parse';
export class VoiceRecipeFailure extends Error {
 constructor(public code:'cancelled'|'timeout'|'provider_unavailable'|'invalid_response'){super(code);}
}
// Only lossless representation changes. Unknown facts stay blank; no inferred prices/units.
export function normalizedDraft(raw:unknown){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
 const copy=structuredClone(raw) as Record<string,unknown>;
 const fact=(v:unknown)=>v===null?'':typeof v==='number'&&Number.isFinite(v)?String(v):typeof v==='string'?v.trim():v;
 delete copy.material_changes;
 copy.selling_price_jpy=fact(copy.selling_price_jpy);
 if(copy.title===null)copy.title='';
 if(Array.isArray(copy.materials))for(const item of copy.materials){
  if(!item||typeof item!=='object'||Array.isArray(item))continue;
  for(const key of ['quantity','price_jpy','price_quantity'])if(key in item)item[key]=fact(item[key]);
  for(const key of ['name','unit','price_unit','supplier'])if(key in item)item[key]=item[key]===null?'':typeof item[key]==='string'?item[key].trim():item[key];
 }
 return parseRecipeDraft(copy);
}
export async function voiceRecipeModel(key:string,system:string,input:unknown,signal:AbortSignal,format:unknown){
 let failure:VoiceRecipeFailure=new VoiceRecipeFailure('invalid_response');
 // One wall-clock budget, including a quick schema repair. Never retry slow transport failures.
 const timeout=AbortSignal.timeout(20000);
 for(let attempt=0;attempt<2;attempt++){
  if(signal.aborted)throw new VoiceRecipeFailure('cancelled');

  try{
   const response=await fetch('https://api.meta.ai/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model:'muse-spark-1.3',reasoning_effort:'low',max_completion_tokens:8192,response_format:format,messages:[{role:'developer',content:system+(attempt?'\nReturn a complete object matching the supplied JSON schema. Do not omit required arrays.':'')},{role:'user',content:JSON.stringify(input)}]}),cache:'no-store',redirect:'error',signal:AbortSignal.any([signal,timeout])});
   if(!response.ok){if(![408,429,500,502,503,504].includes(response.status))throw new VoiceRecipeFailure('invalid_response');throw new VoiceRecipeFailure('provider_unavailable');}
   const raw=await response.text();if(raw.length>65536)throw new VoiceRecipeFailure('invalid_response');
   const data=JSON.parse(raw),choice=data?.choices?.length===1?data.choices[0]:null;
   if(choice?.finish_reason&&choice.finish_reason!=='stop')throw new VoiceRecipeFailure('invalid_response');
   if(typeof choice?.message?.content!=='string')throw new VoiceRecipeFailure('invalid_response');
   const rawDraft=JSON.parse(choice.message.content);
   const changes=rawDraft?.material_changes??[];
   if(!Array.isArray(changes)||changes.length>40||changes.some(c=>!c||Object.keys(c).sort().join('|')!=='action|previous_name|replacement_name'||
      typeof c.previous_name!=='string'||!c.previous_name.trim()||c.previous_name.length>200||!['remove','rename'].includes(c.action)||typeof c.replacement_name!=='string'||c.replacement_name.length>200))throw new VoiceRecipeFailure('invalid_response');
   const result=normalizedDraft(rawDraft);
   if(!result)throw new VoiceRecipeFailure('invalid_response');
   // A valid JSON shell is not a successful revision. Retain the last draft
   // rather than replace a populated recipe with an empty model response.
   const previous=(input as {previous_draft?:{title?:string;materials?:{name?:string}[]}})?.previous_draft;
   if(previous&&((previous.title?.trim()&&!result.title.trim())||
      (previous.materials?.length&&!result.materials.length)))throw new VoiceRecipeFailure('invalid_response');
   const names=new Set(result.materials.map(m=>m.name.trim()));
   for(const old of previous?.materials??[]){
    if(!old.name||names.has(old.name.trim()))continue;
    const change=changes.find(c=>c.previous_name.trim()===old.name!.trim());
    if(!change||(change.action==='rename'&&!names.has(change.replacement_name.trim()))||
       (change.action==='remove'&&change.replacement_name!==''))throw new VoiceRecipeFailure('invalid_response');
   }
   for(const change of changes.slice(0,Math.max(0,10-result.interpretations.length)))result.interpretations.push({source:change.previous_name,suggestion:change.action==='remove'?'削除':change.replacement_name,reason:'発話による食材の削除・名称変更。保存前に確認してください。'});
   return result;
  }catch(err){
   if(signal.aborted)throw new VoiceRecipeFailure('cancelled');
   failure=timeout.aborted?new VoiceRecipeFailure('timeout'):err instanceof VoiceRecipeFailure?err:new VoiceRecipeFailure(err instanceof SyntaxError?'invalid_response':'provider_unavailable');
   if(failure.code!=='invalid_response')throw failure;
  }
 }
 throw failure;
}
