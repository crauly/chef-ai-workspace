// Block 3 (dish image) shared pure helpers. Single source of truth for the
// illustration prompt contract and flight guards; both the voice-draft flow
// (VoiceRecipeRegistration) and the saved-recipe detail section
// (DishImageSection) reuse these so no second image system is introduced.
// The generated image is a preview only, never recipe evidence.
export function dishImagePrompt(title:string,names:string[],hint:string):string{
 const dish=(title||"").trim()||"unspecified dish";
 let items=names.map(n=>n.trim()).filter(Boolean).slice(0,8);
 let extra=hint.trim().slice(0,200);
 const build=()=>`Appetizing food photograph of ${dish}`+(items.length?`, made with ${items.join(", ")}`:"")+(extra?`. ${extra}`:"");
 let prompt=build();
 // The route rejects the whole prompt past 500 chars: shed trailing
 // ingredients first (title + explicit hint carry the intent), then the
 // hint, so the UI never offers a request guaranteed to fail.
 while(prompt.length>500&&items.length>1){items=items.slice(0,-1);prompt=build();}
 if(prompt.length>500){extra="";prompt=build();}
 if(prompt.length>500)prompt=prompt.slice(0,500);
 return prompt;
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
