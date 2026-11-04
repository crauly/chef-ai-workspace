import type {AIProposal, Operation, Recipe} from "./app/types";
import type {PriceReferenceEntry, ResearchStatus} from "./price-enrichment";

export type ResearchResult = {index:number;name:string;status:string;description:string;
 reference?:PriceReferenceEntry;research_status?:ResearchStatus};
export type RecipeResearch = {indices:number[];operations:Operation[];results:ResearchResult[];
 ambiguous:boolean;edit_instruction?:string};

// One predicate for voice routing and the editor. Research never implies saving.
export function isPriceResearchRequest(text:string):boolean {
 const negative=/(?:調べ|探さ|調査し|検索し|比較し|設定し|入れ)(?:ない|なく)|(?:調査|検索|比較)(?:は|を)?しない|\b(?:don't|do not|never)\b/i;
 const research=/(?:価格|単価|値段|仕入値|相場).*(?:調べ|検索|調査|探し|見積|比較)|(?:調べ|検索|調査|探し|見積|比較).*(?:価格|単価|値段|仕入値|相場)|(?:市場価格|参考価格|仮単価|平均価格|最安).*(?:入れ|設定|使|適用|教え)|\b(?:price research|(?:research|look up|check|find|compare|use).*(?:price|prices))\b/i;
 return text.split(/[、。\n,]/).some(part=>!negative.test(part)&&research.test(part))||
  (!negative.test(text)&&research.test(text));
}

// Only grounded price operations may enter a research proposal. Normal proposal
// generation handles the extracted non-price instruction; its prices are ignored.
export function combineResearch(recipe:Recipe,research:RecipeResearch,edit?:AIProposal):AIProposal {
 if(edit&&(edit.recipe_id!==recipe.id||edit.base_revision!==recipe.revision||edit.requires_confirmation!==true))throw new Error("409");
 const operations=[...(edit?.operations??[]).filter(op=>op.op!=="set_material_price")];
 if(operations.some(op=>!["set_title","set_selling_price","set_material_quantity"].includes(op.op)))throw new Error("unsupported combined edit");
 operations.push(...research.operations);
 if(operations.length>40)throw new Error("Too many operations; split the edits");
 return {recipe_id:recipe.id,base_revision:recipe.revision,operations,requires_confirmation:true};
}

export function sourceUrl(value:string):string|null {
 try{const url=new URL(value);return url.protocol==="https:"&&!url.username&&!url.password?url.href:null;}catch{return null;}
}
