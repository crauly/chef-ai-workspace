import {NextRequest,NextResponse} from "next/server";
import {previewAuthorized} from "../../../../../preview-access";
import {backendUrl} from "../../../backend-url";
export async function GET(req:NextRequest,ctx:{params:Promise<{id:string}>}){
 if(!await previewAuthorized(req))return NextResponse.json({error:"forbidden"},{status:403});
 const {id}=await ctx.params;
 if(!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id))
  return NextResponse.json({error:"invalid_id"},{status:400});
 const base=backendUrl(),token=process.env.DEMO_ACCESS_TOKEN;
 if(!base||!token)return NextResponse.json({error:"unavailable"},{status:503});
 try{
  const response=await fetch(new URL("/demo/ingredients/"+id+"/offer-prices",base),{
   headers:{"X-Demo-Access":token},cache:"no-store",redirect:"error",
   signal:AbortSignal.timeout(20000)});
  if(!response.ok)return NextResponse.json({error:"prices_unavailable"},{status:response.status});
  return NextResponse.json(await response.json(),{headers:{"Cache-Control":"no-store"}});
 }catch{return NextResponse.json({error:"prices_unavailable"},{status:502});}
}
