// Shared SSOT for Meta Muse recipe-draft validation (voice + image).
// Extracted verbatim from web/app/api/voice-recipe/route.ts: the strict
// parse() behind the Human Gate. Structured Output guarantees shape only;
// all semantic checks (units, decimals, missing facts blocking approval)
// stay here. Both routes import this; neither may weaken it to pass tests.
const units=new Set(["g","kg","ml","L"]);
const decimal=/^(?:0|[1-9]\d*)(?:\.\d+)?$/;
export type DraftMaterial={name:string;quantity:string;unit:string;price_jpy:string;price_quantity:string;price_unit:string;supplier:string};
export type NameCorrection={material_name:string;heard:string;candidates:{name:string;reason:string}[]};
export type PriceResearch={material_name:string;request:string;material_index?:number|null};
export type RecipeDraft={title:string;materials:DraftMaterial[];selling_price_jpy:string;notes:string[];missing:string[];interpretations:{source:string;suggestion:string;reason:string}[];priceResearch:PriceResearch[];nameCorrections:NameCorrection[]};
export function parseRecipeDraft(raw:unknown):RecipeDraft|null {
 if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
 const o=raw as Record<string,unknown>;
 const optionalKeys=new Set(["interpretations","price_research","name_corrections"]);
 const coreKeys=Object.keys(o).sort().filter(k=>!optionalKeys.has(k)).join("|");
 if(coreKeys!=="materials|notes|selling_price_jpy|title")return null;
 if(typeof o.title!=="string"||o.title.length>200||typeof o.selling_price_jpy!=="string"||o.selling_price_jpy.length>30||
    !Array.isArray(o.materials)||o.materials.length>40||!Array.isArray(o.notes)||o.notes.length>30||
    !o.notes.every(n=>typeof n==="string"&&n.length<=200))return null;
 const materials:DraftMaterial[]=[];
 const nameCorrections=o.name_corrections===undefined?[]:o.name_corrections;
 if(!Array.isArray(nameCorrections)||nameCorrections.length>40||!nameCorrections.every(value=>{
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const item=value as Record<string,unknown>;
  if(Object.keys(item).sort().join("|")!=="candidates|heard|material_name")return false;
  if(typeof item.material_name!=="string"||!item.material_name.trim()||item.material_name.length>200)return false;
  if(typeof item.heard!=="string"||item.heard.length>200)return false;
  const list=item.candidates;
  return Array.isArray(list)&&list.length>=1&&list.length<=3&&list.every(c=>{
   if(!c||typeof c!=="object"||Array.isArray(c))return false;
   const cand=c as Record<string,unknown>;
   return Object.keys(cand).sort().join("|")==="name|reason"&&
    typeof cand.name==="string"&&cand.name.trim().length>0&&cand.name.length<=200&&
    typeof cand.reason==="string"&&cand.reason.trim().length>0&&cand.reason.length<=200;
  });
 }))return null;
 const priceResearch=o.price_research===undefined?[]:o.price_research;
 if(!Array.isArray(priceResearch)||priceResearch.length>10||!priceResearch.every(value=>{
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const item=value as Record<string,unknown>;
  const keys=Object.keys(item).sort().join("|");
  // Strict mode always sends all three keys with null when no row
  // applies; the 2-key shape stays accepted for legacy fixtures only.
  if(keys!=="material_name|request"&&keys!=="material_index|material_name|request")return false;
  if(typeof item.material_name!=="string"||!item.material_name.trim()||item.material_name.length>200)return false;
  if(typeof item.request!=="string"||!item.request.trim()||item.request.length>200)return false;
  // material_index is Muse's row pointer; null/omitted means rowless and
  // never binds a row on its own. Range is checked against materials at
  // bind time, so only the integer-or-null shape is pinned here.
  if(!("material_index" in item))return true;
  if(item.material_index===null)return true;
  if(!(typeof item.material_index==="number"&&
   Number.isInteger(item.material_index)&&item.material_index>=0&&item.material_index<=40))return false;
  return true;
 }))return null;
 const interpretations=o.interpretations===undefined?[]:o.interpretations;
 if(!Array.isArray(interpretations)||interpretations.length>10||!interpretations.every(value=>{
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const item=value as Record<string,unknown>;
  return Object.keys(item).sort().join("|")==="reason|source|suggestion"&&
   Object.values(item).every(text=>typeof text==="string"&&text.trim().length>0&&text.length<=200);
 }))return null;
 for(const x of o.materials){
  if(!x||typeof x!=="object"||Array.isArray(x))return null;
  const m=x as Record<string,unknown>;
  if(Object.keys(m).sort().join("|")!=="name|price_jpy|price_quantity|price_unit|quantity|supplier|unit"||
    !Object.values(m).every(v=>typeof v==="string"&&v.length<=200))return null;
  materials.push(m as DraftMaterial);
 }
 const missing:string[]=[];
 if(!o.title.trim())missing.push("料理名");
 if(o.selling_price_jpy&&!decimal.test(o.selling_price_jpy as string))missing.push("売価の数値");
 for(const [i,m] of materials.entries()){
  if(!m.name.trim())missing.push(`食材${i+1}の名前`);
  if(!decimal.test(m.quantity)||!units.has(m.unit))missing.push(`${m.name||"食材"}の数量・単位`);
  if(!decimal.test(m.price_jpy)||!decimal.test(m.price_quantity)||Number(m.price_quantity)<=0||!units.has(m.price_unit))
   missing.push(`${m.name||"食材"}の仕入単価・基準数量・単位`);
 }
 return {title:(o.title as string).trim(),materials,selling_price_jpy:o.selling_price_jpy as string,notes:o.notes as string[],missing,interpretations:interpretations as RecipeDraft["interpretations"],priceResearch:priceResearch as PriceResearch[],nameCorrections:nameCorrections as NameCorrection[]};
}
