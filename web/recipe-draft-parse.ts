// Shared SSOT for Meta Muse recipe-draft validation (voice + image).
// Extracted verbatim from web/app/api/voice-recipe/route.ts: the strict
// parse() behind the Human Gate. Structured Output guarantees shape only;
// all semantic checks (units, decimals, missing facts blocking approval)
// stay here. Both routes import this; neither may weaken it to pass tests.
const validUnit=(unit:string)=>unit.length>0&&unit.length<=32&&unit.trim()===unit;
// Lossless spelling normalization; never infer a quantity, unit or price.
export function draftNumber(value:unknown,positive=false):string|null{
 if(typeof value!=="string"&&typeof value!=="number")return null;
 let text=String(value).normalize("NFKC").trim();
 if(/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text))text=text.replace(/,/g,"");
 if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text))return null;
 const [mantissa,exponent]=text.toLowerCase().split('e');
 const zero=!/[1-9]/.test(mantissa);
 const exponentValue=Number(exponent??0),digits=mantissa.replace(/^[+-]/,'').split('.');
 if(digits[1])digits[1]=digits[1].replace(/0+$/,'');
 const before=(digits[0].replace(/^0+/, '').length||-(digits[1]?.search(/[1-9]/)??0));
 if(!zero&&(!Number.isFinite(exponentValue)||before+exponentValue>131072||(digits[1]?.length??0)-exponentValue>16383))return null;
 if((mantissa.startsWith('-')&&!zero)||(positive&&zero))return null;
 const [whole,fraction=""]=mantissa.replace(/^[+-]/,"").split('.');
 const tail=fraction.replace(/0+$/,"");
 text=zero?'0':(whole.replace(/^0+(?=\d)/,"")||'0')+(tail?'.'+tail:'')+(exponent?'e'+exponent:'');
 return text.length<=30?text:null;
}
export type DraftIssue={path:string;reason:string};
export function registrationIssues(draft:{title:string;selling_price_jpy:string;materials:DraftMaterial[]}):DraftIssue[]{
 const issues:DraftIssue[]=[];
 const number=(value:string,path:string,positive=false)=>{if(value&&draftNumber(value,positive)===null)issues.push({path,reason:positive?'30文字以内の0より大きい数値が必要です':'30文字以内の0以上の数値が必要です'});};
 number(draft.selling_price_jpy,'selling_price_jpy',true);
 draft.materials.forEach((m,i)=>{
  const path=`materials.${i}`;
  number(m.quantity,path+'.quantity');number(m.price_jpy,path+'.price_jpy');number(m.price_quantity,path+'.price_quantity',true);
  for(const key of ['unit','price_unit'] as const)if(m[key]&&!validUnit(m[key].normalize('NFKC').trim()))issues.push({path:path+'.'+key,reason:'単位は32文字以内で指定してください'});
  if(Boolean(m.quantity)!==Boolean(m.unit))issues.push({path:path+'.quantity',reason:'使用数量と単位が揃わないため未確定になります'});
  const prices=[m.price_jpy,m.price_quantity,m.price_unit];if(prices.some(Boolean)&&!prices.every(Boolean))issues.push({path:path+'.price_jpy',reason:'仕入価格・基準数量・単位が揃わないため未確定になります'});
 });
 return issues;
}
export type DraftMaterial={name:string;quantity:string;unit:string;price_jpy:string;price_quantity:string;price_unit:string;supplier:string};
export type NameCorrection={material_name:string;heard:string;candidates:{name:string;reason:string}[]};
export type PriceResearch={material_name:string;request:string;material_index?:number|null};
export type UnitProposal={symbol:string;dimension:"mass"|"volume"|"count"|"other"};
export type RecipeDraft={unitProposals:UnitProposal[];title:string;materials:DraftMaterial[];selling_price_jpy:string;notes:string[];missing:string[];interpretations:{source:string;suggestion:string;reason:string}[];priceResearch:PriceResearch[];nameCorrections:NameCorrection[]};
export function parseRecipeDraft(raw:unknown,issues:DraftIssue[]=[]):RecipeDraft|null {
 const invalid=(path:string,reason:string)=>{issues.push({path,reason});return null;};
 if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
 const o=raw as Record<string,unknown>;
 const optionalKeys=new Set(["interpretations","price_research","name_corrections","unit_proposals"]);
 const coreKeys=Object.keys(o).sort().filter(k=>!optionalKeys.has(k)).join("|");
 if(coreKeys!=="materials|notes|selling_price_jpy|title")return null;
 if(typeof o.title!=="string"||o.title.length>200)return invalid('title','料理名は200文字以内で指定してください');
 if(typeof o.selling_price_jpy!=="string"||o.selling_price_jpy.length>200)return invalid('selling_price_jpy','売価の入力形式を確認してください');
 if(!Array.isArray(o.materials)||o.materials.length>40)return invalid('materials','食材は40件以内の一覧で指定してください');
 if(!Array.isArray(o.notes)||o.notes.length>30||!o.notes.every(n=>typeof n==="string"&&n.length<=200))return invalid('notes','確認事項の形式を確認してください');
 const unitProposals=o.unit_proposals===undefined?[]:o.unit_proposals;
 if(!Array.isArray(unitProposals)||unitProposals.length>80||
   !unitProposals.every(v=>v&&typeof v==="object"&&!Array.isArray(v)&&
    Object.keys(v).sort().join("|")==="dimension|symbol"&&
    typeof v.symbol==="string"&&v.symbol.trim().length>0&&v.symbol.length<=32&&
    ["mass","volume","count","other"].includes(v.dimension as string)))return null;
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
 if(!Array.isArray(priceResearch)||priceResearch.length>40||!priceResearch.every(value=>{
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
 for(const [index,x] of o.materials.entries()){
  if(!x||typeof x!=="object"||Array.isArray(x))return null;
  const m=x as Record<string,unknown>;
  if(Object.keys(m).sort().join("|")!=="name|price_jpy|price_quantity|price_unit|quantity|supplier|unit")return invalid(`materials.${index}`,"食材のフィールド構成を確認してください");
  for(const [field,value] of Object.entries(m))if(typeof value!=="string"||(['name','supplier'].includes(field)&&value.length>200))return invalid(`materials.${index}.${field}`,"名前・仕入先は200文字以内、各フィールドは文字列で指定してください");
  const row={...m} as DraftMaterial;
  for(const key of ['name','supplier','unit','price_unit'] as const)row[key]=row[key].normalize('NFKC').trim();
  for(const key of ['quantity','price_jpy','price_quantity'] as const)row[key]=draftNumber(row[key],key==='price_quantity')??row[key];
  materials.push(row);
 }
 const missing:string[]=registrationIssues({title:o.title as string,selling_price_jpy:o.selling_price_jpy as string,materials}).map(i=>i.path+": "+i.reason);
 if(!o.title.trim())missing.push("料理名");
 if(o.selling_price_jpy&&draftNumber(o.selling_price_jpy,true)===null)missing.push("売価の数値");
 for(const [i,m] of materials.entries()){
  if(!m.name.trim())missing.push(`食材${i+1}の名前`);
  if(draftNumber(m.quantity)===null||!validUnit(m.unit))missing.push(`${m.name||"食材"}の数量・単位`);
  if(draftNumber(m.price_jpy)===null||draftNumber(m.price_quantity,true)===null||!validUnit(m.price_unit))
   missing.push(`${m.name||"食材"}の仕入単価・基準数量・単位`);
 }
 return {unitProposals:unitProposals as UnitProposal[],title:(o.title as string).trim(),materials,selling_price_jpy:draftNumber(o.selling_price_jpy,true)??o.selling_price_jpy as string,notes:o.notes as string[],missing,interpretations:interpretations as RecipeDraft["interpretations"],priceResearch:priceResearch as PriceResearch[],nameCorrections:nameCorrections as NameCorrection[]};
}
