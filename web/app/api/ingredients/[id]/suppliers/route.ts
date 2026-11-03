import {NextRequest,NextResponse} from "next/server";
import {previewAuthorized,sameOrigin} from "../../../../../preview-access";
import {backendUrl} from "../../../backend-url";

export async function POST(req:NextRequest,ctx:{params:Promise<{id:string}>}){
 if(!await previewAuthorized(req)||!sameOrigin(req))return NextResponse.json({error:"forbidden"},{status:403});
 const {id}=await ctx.params;
 if(!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id))return NextResponse.json({error:"invalid_id"},{status:400});
 const base=backendUrl(),token=process.env.DEMO_ACCESS_TOKEN;
 if(!base||!token)return NextResponse.json({error:"unavailable"},{status:503});
 try{
  const raw=await req.text();
  if(raw.length>512)return NextResponse.json({error:"too_large"},{status:413});
  const response=await fetch(new URL("/demo/ingredients/"+id+"/suppliers",base),{
   method:"POST",headers:{"X-Demo-Access":token,"Content-Type":"application/json"},
   body:raw,cache:"no-store",redirect:"error",signal:AbortSignal.timeout(20000),
  });
  if(!response.ok)return NextResponse.json({error:"ingredient_supplier_link_failed"},{status:response.status});
  return NextResponse.json(await response.json(),{status:201,headers:{"Cache-Control":"no-store"}});
 }catch{return NextResponse.json({error:"ingredient_supplier_link_failed"},{status:502});}
}
