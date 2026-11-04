import {NextRequest, NextResponse} from "next/server";
import {safeIngredientSaveCode} from "../../ingredient-save-contract";
import {previewAuthorized, sameOrigin} from "../../preview-access";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Action = "" | "/cost" | "/confirm" | "/confirm/review" | "/propose" | "/corrections" | "/full" | "/full/review";
function failure(status: number,code?:string,issues?:{path:string;reason:string}[]) {
  return NextResponse.json({error: code??"Workspace request failed",...(issues?{issues}:{})}, {status, headers: {"Cache-Control": "no-store"}});
}
// Recheck access at the privileged proxy, independently of middleware.
export async function forward(req: NextRequest, id?: string, action: Action = "") {
  if (!await previewAuthorized(req)) return failure(403);
  if (id !== undefined && !uuid.test(id)) return failure(400);
  if ((req.method === "POST" || req.method === "DELETE") && !sameOrigin(req)) return failure(403);
  // Browser tests use only the loopback mock; production never falls back to Render.
  const localMock = process.env.FASTAPI_BASE_URL;
  const api = process.env.CHEF_FASTAPI_INTERNAL_URL ||
    (localMock && (localMock.startsWith("http://127.0.0.1:") || localMock.startsWith("http://localhost:")) ? localMock : undefined);
  const key = process.env.DEMO_ACCESS_TOKEN;
  if (!api || !key) return failure(503);
  try {
    const base = new URL(api);
    if (!["https:","http:"].includes(base.protocol) || base.username || base.password) return failure(503);
    const body = req.method === "POST" ? await req.text() : undefined;
    if (body && new TextEncoder().encode(body).length > 65536) return failure(413);
    const path = "/demo/recipes" + (id ? "/" + encodeURIComponent(id) + action : (action === "/full" || action === "/full/review") ? action : "");
    const url = new URL(path, base);
    if (!id) for (const name of ["page", "page_size", "q"]) {
      const value = req.nextUrl.searchParams.get(name);
      if (value) url.searchParams.set(name, value);
    }
    const response = await fetch(url, {
      method: req.method, headers: {"X-Demo-Access": key, "Content-Type": "application/json"},
      body, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30000),
    });
    // Do not reflect backend/provider errors or private response headers.
    if (!response.ok){
      let data:{error?:unknown;detail?:unknown}={};try{data=await response.json();}catch{}
      if(response.status===422&&(action==='/full'||action==='/full/review')){
        const fields=new Set(['title','materials','name','quantity','unit','price_jpy','price_quantity','price_unit','supplier','spec','ingredient_id','new_master','selling_price_jpy','unit_candidates','symbol','dimension']);
        const issues=(Array.isArray(data.detail)?data.detail:[]).slice(0,20).map((issue:{loc?:unknown;type?:string})=>{
          const loc=Array.isArray(issue.loc)?issue.loc.filter(x=>x!=='body'):[];
          const path=loc.length&&loc.every(x=>typeof x==='number'||(typeof x==='string'&&fields.has(x)))?loc.join('.'):'recipe';
          const reason=issue.type==='string_too_long'?'文字数上限を超えています':issue.type==='missing'?'必須項目がありません':path.startsWith('unit_candidates')?'新規単位の分類を指定し、重複・曖昧な単位を確認してください':'数値・数量と単位・価格3項目の入力条件を確認してください';
          return {path,reason};
        });
        return failure(422,'invalid_input',issues.length?issues:[{path:'recipe',reason:'入力契約を確認してください'}]);
      }
      const known:Record<string,string>={"Unknown or ambiguous unit":"unit_unknown","Recipe supplier must belong to owner":"supplier_unavailable","Ingredient not owned":"ingredient_unavailable","Ingredient identity collision":"ingredient_conflict","Ambiguous purchase offer":"ingredient_conflict","Choose an ingredient master before saving":"ingredient_conflict","Ambiguous ingredient identity":"ingredient_conflict","Invalid material price or price unit":"invalid_price","Invalid purchase price":"invalid_price","Invalid material quantity":"invalid_input","Invalid quantity or unit":"invalid_input"};
      const code=safeIngredientSaveCode(data.error)??(typeof data.detail==='string'?known[data.detail]:undefined);
      return failure(response.status >= 400 && response.status < 600 ? response.status : 502,code);
    }
    return NextResponse.json(await response.json(), {status: response.status, headers: {"Cache-Control": "no-store"}});
  } catch {return failure(502);}
}
