import type {Recipe} from "./types";
// Derived only from saved recipe data, never a stale AI-generated missing list.
export function recipeGaps(recipe:Recipe):string[]{
 const gaps:string[]=[];
 if(!recipe.selling_price_jpy.value)gaps.push("売価");
 for(const [index,m] of recipe.materials.entries()){
  const name=m.material_name.value?.trim()||`食材${index+1}`;
  if(!m.quantity.value||!m.unit)gaps.push(`${name}：使用量・単位`);
  if(!m.price_override&&m.price_mode!=="inherit")gaps.push(`${name}：仕入単価`);
 }
 return gaps;
}
