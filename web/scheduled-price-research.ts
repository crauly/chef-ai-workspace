import {runGroundedSearch,type GroundedOutcome} from './price-web-search';
export type ResearchJob={ingredient_id:string;token:string;name:string;brand?:string|null;spec?:string|null};
type Backend=(action:string,payload?:unknown)=>Promise<unknown>;
export async function runScheduledResearch(backend:Backend,apiKey:string,search=runGroundedSearch){
 const jobs=await backend('claim') as ResearchJob[];
 if(!Array.isArray(jobs)||jobs.length>3)throw new Error('invalid jobs');
 return Promise.allSettled(jobs.map(async job=>{
  try{
   // Ledger pricing is a comparison basis, never relabeled as a fresh market search.
   const name=[job.name,job.brand,job.spec].filter(Boolean).join(' ');
   const result:GroundedOutcome=await search({apiKey,materialName:name,request:'この品名・メーカー・規格の現在の販売価格を調査。異なる規格は明記。価格条件とURLを返す。',timeoutMs:20000});
   const sample=result.kind==='found'&&result.entry.currency==='JPY'?result.entry.samples.find(s=>s.url?.startsWith('https://')&&s.package_quantity&&s.package_unit):undefined;
   return await backend('finish',{ingredient_id:job.ingredient_id,token:job.token,candidate:sample?{...sample,currency:'JPY'}:null,error:sample?null:result.kind==='found'?'source_or_terms_missing':result.kind});
  }catch{
   return backend('finish',{ingredient_id:job.ingredient_id,token:job.token,error:'research_failed'});
  }
 }));
}
