// Block 3 (dish image) shared pure helpers. Single source of truth for the
// illustration prompt contract and flight guards; both the voice-draft flow
// (VoiceRecipeRegistration) and the saved-recipe detail section
// (DishImageSection) reuse these so no second image system is introduced.
// The generated image is a preview only, never recipe evidence.
export function dishImagePrompt(title:string,names:string[],hint:string):string{
 // One shared visual contract for draft and saved-recipe images.
 // Names inform the finished dish only: they are NOT instructions to
 // arrange ingredient packets or loose ingredients around the plate.
 const prefix="Natural editorial restaurant photograph of the finished plated dish: ";
 const rules=". Only the prepared food on one simple plate, on a plain table. Close framing, soft daylight, realistic textures and colors, unretouched camera photo. No raw or scattered ingredients, packaging, labels, brands, utensils, props, extra plates, text, artificial gloss or stylized advertising.";
 const dish=(title||"").trim()||"unspecified dish";
 const items=names.map(n=>n.trim()).filter(Boolean).slice(0,8);
 const extra=hint.trim().slice(0,200);
 // Preserve the photographic constraints even for oversized user inputs.
 const budget=500-prefix.length-rules.length;
 let subject=dish.slice(0,Math.max(1,budget));
 if(subject.length+extra.length+4<=budget&&extra)subject+=`. ${extra}`;
 if(items.length&&subject.length+12<budget){
  const context=` (made with ${items.join(", ")})`;
  subject+=context.slice(0,Math.max(0,budget-subject.length));
 }
 return prefix+subject+rules;
}
// An aborted flight is a normal cancellation, never an API failure; a
// result belongs only to the recipe/draft it started from, so a
// discarded/saved/replaced target never receives it.
export function isAbortError(err:unknown):boolean{
 return !!err&&typeof err==="object"&&"name" in err&&(err as {name?:unknown}).name==="AbortError";
}
export function dishCompletionKept(started:object|null,current:object|null,aborted:boolean):boolean{
 return !aborted&&started!==null&&started===current;
}
