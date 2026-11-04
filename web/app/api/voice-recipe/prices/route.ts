import {NextRequest, NextResponse} from "next/server";
import {previewAuthorized} from "../../../../preview-access";
import {bindRow,enrichEntries,provisionalFor} from "../../../../price-enrichment";
export const runtime="nodejs";
export const maxDuration=60;
// Deferred price enrichment for POST /api/voice-recipe with defer_prices.
// Stateless: the caller sends the CURRENT materials snapshot plus the
// pending entries, and every entry is re-bound here against those fresh
// rows (exact row-name match beats a contradictory index; a valid index
// wins over a drifted name; otherwise rowless, searched by name but never
// bound). A response for a superseded draft therefore cannot mis-attach:
// the UI row gate (material_index + ROW material_name on provisionals)
// only applies entries whose row still matches the live draft. Read-only:
// same ledger-first/grounding-fallback validation as the inline path,
// materials untouched, nothing saved, approval never implied.
const error=(status:number)=>NextResponse.json({error:"Voice price research failed"},{status,headers:{"Cache-Control":"no-store"}});
export async function POST(req:NextRequest){
 if(!await previewAuthorized(req))return error(403);
 if(req.headers.get("origin")!==req.nextUrl.origin)return error(403);
 const key=process.env.MODEL_API_KEY;if(!key)return error(503);
 try{
  const raw=await req.text();if(new TextEncoder().encode(raw).length>64000)return error(413);
  const input:unknown=JSON.parse(raw);
  if(!input||typeof input!=="object"||Array.isArray(input))return error(400);
  const body=input as Record<string,unknown>;
  if(!Array.isArray(body.materials)||body.materials.length>40)return error(400);
  const materials:{name:string}[]=[];
  for(const m of body.materials){
   if(!m||typeof m!=="object"||Array.isArray(m)||typeof (m as {name?:unknown}).name!=="string"||
    (m as {name:string}).name.length>200)return error(400);
   materials.push({name:(m as {name:string}).name});
  }
  if(!Array.isArray(body.entries)||body.entries.length>40)return error(400);
  const rawEntries:{material_name:string;request:string;material_index?:number|null;row_name?:string|null}[]=[];
  for(const e of body.entries){
   if(!e||typeof e!=="object"||Array.isArray(e))return error(400);
   const item=e as Record<string,unknown>;
   if(typeof item.material_name!=="string"||!item.material_name.trim()||item.material_name.length>200)return error(400);
   if(typeof item.request!=="string"||!item.request.trim()||item.request.length>200)return error(400);
   // -1 is this API's own rowless marker (pending_research emits it);
   // null/omitted means rowless too (UI normalizes -1 to null on send).
   if("material_index" in item&&item.material_index!==null&&item.material_index!==undefined&&
    !(typeof item.material_index==="number"&&Number.isInteger(item.material_index)&&
     (item.material_index===-1||(item.material_index>=0&&item.material_index<=40))))return error(400);
   // row_name is the materials[] row name the entry was created against;
   // it lets a stale pointer be discarded instead of binding another row.
   if("row_name" in item&&item.row_name!==null&&item.row_name!==undefined&&
    !(typeof item.row_name==="string"&&item.row_name.length<=200))return error(400);
   const rowName=typeof item.row_name==="string"&&item.row_name.trim()?item.row_name.trim():undefined;
   rawEntries.push({material_name:item.material_name,request:item.request,
    material_index:("material_index" in item&&(typeof item.material_index==="number"||item.material_index===null))
     ?item.material_index as number|null:undefined,row_name:rowName});
  }
  // Re-bind against the submitted snapshot with the identity check;
  // Muse-origin entries keep trigger "muse" so research_status stays
  // comparable with inline mode.
  const entries=rawEntries.map(e=>({material_name:e.material_name,request:e.request,
   trigger:"muse" as const,material_index:bindRow(materials,e.material_name,e.row_name,e.material_index)}));
  // No heuristic gap-fill here: the caller supplies the full pending
  // set (inline mode already merged Muse + heuristic entries).
  const {priceReferences,researchStatus}=await enrichEntries(key,entries);
  const provisionalPrices=materials.map((m,i)=>provisionalFor(i,m,priceReferences));
  return NextResponse.json({price_references:priceReferences,research_status:researchStatus,
   provisional_prices:provisionalPrices,research_state:"complete"},
   {headers:{"Cache-Control":"no-store"}});
 }catch{return error(502);}
}
