// Canonical recipe identity shared by the browser cache and cloud API proxy.
// A UUID has three middle four-hex groups: 8-4-4-4-12.
const RECIPE_ID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export function isRecipeId(value:string):boolean{return RECIPE_ID.test(value);}
