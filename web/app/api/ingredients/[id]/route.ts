import {NextRequest,NextResponse} from "next/server";
import {previewAuthorized,sameOrigin} from "../../../../preview-access";
import {safeIngredientSaveCode} from "../../../../ingredient-save-contract";
import {backendUrl} from "../../backend-url";

export async function PUT(req:NextRequest,ctx:{params:Promise<{id:string}>}){
 if(!await previewAuthorized(req)||!sameOrigin(req))return NextResponse.json({error:"forbidden"},{status:403});
 const {id}=await ctx.params;
 if(!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id))return NextResponse.json({error:"invalid_id"},{status:400});
 const base=backendUrl(),token=process.env.DEMO_ACCESS_TOKEN;
 if(!base||!token)return NextResponse.json({error:"api_unavailable"},{status:503});
 try{
  const raw=await req.text();
  if(raw.length>4096)return NextResponse.json({error:"too_large"},{status:413});
  const response=await fetch(new URL("/demo/ingredients/"+id,base),{
   method:"PUT",headers:{"X-Demo-Access":token,"Content-Type":"application/json"},
   body:raw,cache:"no-store",redirect:"error",signal:AbortSignal.timeout(20000)
  });
  if(!response.ok){
   let data:unknown;try{data=await response.json();}catch{}
   const code=safeIngredientSaveCode((data as {error?:unknown})?.error)??(response.status===422?"invalid_input":response.status>=500?"database_error":"api_unavailable");
   return NextResponse.json({error:code},{status:response.status,headers:{"Cache-Control":"no-store"}});
  }
  return NextResponse.json(await response.json(),{headers:{"Cache-Control":"no-store"}});
 }catch{return NextResponse.json({error:"api_unavailable"},{status:502,headers:{"Cache-Control":"no-store"}});}
}

export async function DELETE(req:NextRequest,ctx:{params:Promise<{id:string}>}){
 if(!await previewAuthorized(req)||!sameOrigin(req))return NextResponse.json({error:"forbidden"},{status:403});
 const {id}=await ctx.params;
 if(!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id))return NextResponse.json({error:"invalid_id"},{status:400});
 const base=backendUrl(),token=process.env.DEMO_ACCESS_TOKEN;
 if(!base||!token)return NextResponse.json({error:"unavailable"},{status:503});
 try{
  const response=await fetch(new URL("/demo/ingredients/"+id,base),{
   method:"DELETE",headers:{"X-Demo-Access":token},cache:"no-store",redirect:"error",signal:AbortSignal.timeout(20000)});
  if(!response.ok)return NextResponse.json({error:"master_delete_failed"},{status:response.status});
  return NextResponse.json(await response.json(),{headers:{"Cache-Control":"no-store"}});
 }catch{return NextResponse.json({error:"master_delete_failed"},{status:502});}
}
