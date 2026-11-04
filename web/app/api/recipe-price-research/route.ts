import {NextRequest,NextResponse} from "next/server";
import {previewAuthorized,sameOrigin} from "../../../preview-access";
import {enrichEntries,type PriceReferenceEntry} from "../../../price-enrichment";
import {backendUrl} from "../backend-url";
import type {Recipe} from "../../types";
import type {RecipeResearch,ResearchResult} from "../../../recipe-price-research";

export const runtime="nodejs";
const fail=(status:number,message:string)=>NextResponse.json({error:message},{status,headers:{"Cache-Control":"no-store"}});
const selectionSchema={type:"object",properties:{indices:{type:"array",items:{type:"integer"}},edit_instruction:{type:"string"}},required:["indices","edit_instruction"],additionalProperties:false};
type Unit={id:string;symbol:string;aliases?:string[];dimension:string;base_factor:string|null};
const positive=(value:string|null)=>value!==null&&Number.isFinite(Number(value))&&Number(value)>0;
function resolveUnit(units:Unit[],text:string|null,id?:string|null){
 const found=units.filter(u=>id?u.id===id:u.symbol===text||(u.aliases??[]).includes(text??""));
 return found.length===1?found[0]:undefined;
}


// External summaries normalize packages. Verify that normalization against the
// approved owner factors too; a helper's built-in kg/g ratio is not authority.
function verifiedExternalBasis(ref:PriceReferenceEntry,units:Unit[],basis:Unit|undefined){
 if(ref.origin!=="external")return true;
 if(!basis||!ref.samples?.length)return false;
 let total=0;
 for(const sample of ref.samples){
  const from=resolveUnit(units,sample.package_unit??null);
  if(!from||!positive(sample.package_quantity??null))return false;
  let quantity=Number(sample.package_quantity);
  if(from.id!==basis.id){
   if(from.dimension!==basis.dimension||!positive(from.base_factor)||!positive(basis.base_factor))return false;
   quantity*=Number(from.base_factor)/Number(basis.base_factor);
  }
  const price=Number(sample.amount)/quantity;
  if(!Number.isFinite(price)||price<0)return false;
  total+=price;
 }
 return Number((total/ref.samples.length).toFixed(4))===Number(ref.average_unit_price);
}

// Read-only. Recipe ownership/revision and purchasing identity come from the
// trusted backend, never client-supplied row names/supplier flags. The existing
// confirm endpoint is still the sole explicit approval and atomic write gate.
export async function POST(req:NextRequest){
 if(!await previewAuthorized(req)||!sameOrigin(req))return fail(403,"Unauthorized");
 const apiKey=process.env.MODEL_API_KEY;
 if(!apiKey)return fail(503,"Model unavailable");
 try{
  const raw=await req.text();
  if(new TextEncoder().encode(raw).length>16000)return fail(413,"Request too large");
  let body:unknown;
  try{body=JSON.parse(raw);}catch{return fail(400,"Invalid JSON");}
  if(!body||typeof body!=="object"||Array.isArray(body))return fail(400,"Invalid request");
  const input=body as Record<string,unknown>;
  if(typeof input.instruction!=="string"||!input.instruction.trim()||input.instruction.length>4000||
     typeof input.recipe_id!=="string"||! /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.recipe_id)||
     !Number.isSafeInteger(input.base_revision)||Number(input.base_revision)<0)return fail(400,"Invalid request");
  const backend=backendUrl(),access=process.env.DEMO_ACCESS_TOKEN;
  if(!backend||!access)return fail(503,"Backend unavailable");
  const read=(path:string)=>fetch(new URL(path,backend),{headers:{"X-Demo-Access":access},cache:"no-store",redirect:"error",signal:AbortSignal.timeout(15000)});
  const saved=await read("/demo/recipes/"+encodeURIComponent(input.recipe_id));
  if(!saved.ok)return fail([401,403,404].includes(saved.status)?saved.status:502,"Recipe unavailable");
  const recipe=await saved.json() as Recipe;
  if(recipe.id!==input.recipe_id||recipe.revision!==input.base_revision)return fail(409,"Stale recipe");
  if(!Array.isArray(recipe.materials)||!recipe.materials.length||recipe.materials.length>40)return fail(400,"Invalid materials");
  const materials=recipe.materials.map(m=>({...m,name:(recipe.display_names?.[m.id]?.display||m.material_name.value||"").trim()}));
  if(materials.some(m=>!m.name||m.name.length>200)||new Set(materials.map(m=>m.id)).size!==materials.length)return fail(502,"Invalid saved materials");
  const system=`You identify EXACTLY which material rows a chef wants to research for provisional market purchase prices. The instruction can be Japanese or English. Select all rows for "全部", "すべて", "全材料", "all", and equivalents. Support named subsets, multiple names, ranges such as "AからBまで" (inclusive, by the order supplied), and contextual pronouns. Do not assume only one row is meant. Use only valid zero-based indices from the provided materials list. If the scope cannot be determined confidently, return an empty indices array. Also return edit_instruction: copy ONLY the chef-requested non-price edits (quantities, selling price, recipe title), preserving all prior corrections and latest overrides in the instruction history. Return an empty string when there are none. Never add a change, invent numbers, or include researched purchase prices in edit_instruction. Respect negations/exclusions. This is selection ONLY, never a price estimate or authorization.`;
  const response=await fetch("https://api.meta.ai/v1/chat/completions",{
   method:"POST",headers:{"Authorization":"Bearer "+apiKey,"Content-Type":"application/json"},
   body:JSON.stringify({model:"muse-spark-1.3",reasoning_effort:"low",max_completion_tokens:1024,
    response_format:{type:"json_schema",json_schema:{name:"recipe_price_scope",strict:true,schema:selectionSchema}},
    messages:[{role:"developer",content:system},{role:"user",content:JSON.stringify({instruction:input.instruction,materials:materials.map((m,i)=>({index:i,name:m.name}))})}]}),
   cache:"no-store",redirect:"error",signal:AbortSignal.timeout(25000)
  });
  if(!response.ok)return fail(502,"Scope selection failed");
  const model:unknown=await response.json();
  const choices=model&&typeof model==="object"?(model as {choices?:unknown}).choices:null;
  if(!Array.isArray(choices)||choices.length!==1)return fail(502,"Invalid selection");
  const choice=choices[0] as {message?:{content?:unknown}};
  if((choices[0] as {finish_reason?:string}).finish_reason!=="stop"||typeof choice?.message?.content!=="string")return fail(502,"Invalid selection");
  const parsed:unknown=JSON.parse(choice.message.content);
  if(!parsed||typeof parsed!=="object"||!Array.isArray((parsed as {indices?:unknown}).indices))return fail(502,"Invalid selection");
  const editInstruction=(parsed as {edit_instruction?:unknown}).edit_instruction;
  if(typeof editInstruction!=="string"||editInstruction.length>4000)return fail(502,"Invalid edit instruction");
  const indices=(parsed as {indices:unknown[]}).indices;
  if(!indices.every(i=>typeof i==="number"&&Number.isInteger(i)&&i>=0&&i<materials.length))return fail(502,"Invalid indices");
  const unique=[...new Set(indices as number[])].sort((a,b)=>a-b);
  if(!unique.length)return NextResponse.json({indices:[],operations:[],results:[],ambiguous:true,edit_instruction:editInstruction},{headers:{"Cache-Control":"no-store"}});
  const unitResponse=await read("/demo/units");
  if(!unitResponse.ok)return fail(503,"Unit master unavailable");
  const unitBody=await unitResponse.json() as {items?:Unit[]};
  if(!Array.isArray(unitBody.items))return fail(502,"Invalid unit master");
  const units=unitBody.items;
  const results:ResearchResult[]=[];
  const operations:RecipeResearch["operations"]=[];
  const entries=unique.map(i=>({material_name:materials[i].name,material_index:i,ingredient_id:materials[i].ingredient_id??undefined,request:input.instruction as string,trigger:"muse" as const}));
  // Three concurrent searches, not three selected ingredients. Every selected
  // row gets a result and source evidence; failures never become zero prices.
  // Repeated recipe lines share one Ingredient price. Research it once so
  // independent searches cannot propose conflicting updates to the same SSOT.
  const grouped=new Map<string,typeof entries>();
  for(const entry of entries){const key=entry.ingredient_id??`row:${entry.material_index}`;grouped.set(key,[...(grouped.get(key)??[]),entry]);}
  const groups=[...grouped.values()];
  for(let offset=0;offset<groups.length;offset+=3){
   const batch=groups.slice(offset,offset+3);
   const {priceReferences,researchStatus}=await enrichEntries(apiKey,batch.map(group=>group[0]),(ref,entry)=>{
    const row=materials[entry.material_index],quote=resolveUnit(units,ref.unit_basis),lineUnit=resolveUnit(units,row.unit,row.unit_id);
    return ref.currency==="JPY"&&typeof ref.average_unit_price==="string"&&
     /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(ref.average_unit_price)&&positive(ref.average_unit_price)&&
     !!quote&&!!lineUnit&&(quote.id===lineUnit.id||quote.dimension===lineUnit.dimension&&positive(quote.base_factor)&&positive(lineUnit.base_factor));
   });
   batch.forEach((group,j)=>{for(const entry of group){
    const ref={...priceReferences[j],material_index:entry.material_index};
    const row=materials[entry.material_index];
    const price=ref.average_unit_price;
    const quoteUnit=resolveUnit(units,ref.unit_basis);
    const recipeUnit=resolveUnit(units,row.unit,row.unit_id);
    const compatible=quoteUnit&&recipeUnit&&(quoteUnit.id===recipeUnit.id||
      quoteUnit.dimension===recipeUnit.dimension&&positive(quoteUnit.base_factor)&&positive(recipeUnit.base_factor));
    let status:string=ref.status;
    if(ref.status==="available"){
     status=ref.currency!=="JPY"?"unsupported_currency":
      typeof price!=="string"||! /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(price)||!positive(price)?"invalid_price":
      !row.ingredient_id&&ref.origin==="ledger"&&ref.ingredient_name!==row.name?"identity_mismatch":
      !quoteUnit?"unknown_unit":!compatible?"incompatible_unit":
      !verifiedExternalBasis(ref,units,quoteUnit)?"unverified_conversion":"candidate";
    }
    if(row.supplier_id||row.offer_id)status="linked_supplier";
    results.push({index:entry.material_index,name:row.name,status,
     description:ref.text+(status==="linked_supplier"?"（仕入先・購入条件が指定されています。比較参考値のみ。価格採用は既存の仕入条件確認・承認経路で行い、ここでは既存価格を変更しません。）":"")+(ref.origin==="external"&&researchStatus[j].ledger==="available"?"（仕入履歴は通貨・単位等の原価条件に合わないためWeb参考値を取得）":"")+(status!=="candidate"?`（候補なし：${status}）`: "（未承認の仮単価。共有食材の採用価格を更新する変更案です。）"),
     reference:ref,research_status:{...researchStatus[j],material_index:entry.material_index}});
    if(status==="candidate")operations.push({op:"set_material_price",material_id:row.id,
     price_jpy:price!,price_quantity:"1",price_unit:quoteUnit!.symbol});
   }});
  }
  results.sort((a,b)=>a.index-b.index);
  return NextResponse.json({indices:unique,operations,results,ambiguous:false,edit_instruction:editInstruction},{headers:{"Cache-Control":"no-store"}});
 }catch{return fail(502,"Price research failed");}
}
