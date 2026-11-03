import {NextRequest,NextResponse} from "next/server";
import {previewAuthorized,sameOrigin} from "../../../../preview-access";
import {backendUrl} from "../../backend-url";
export async function PUT(req:NextRequest,ctx:{params:Promise<{id:string}>}){
 if(!await previewAuthorized(req)||!sameOrigin(req))return NextResponse.json({error:"forbidden"},{status:403});
 const {id}=await ctx.params;
 if(!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id))return NextResponse.json({error:"invalid_id"},{status:400});
 const base=backendUrl(),token=process.env.DEMO_ACCESS_TOKEN;
 if(!base||!token)return NextResponse.json({error:"unavailable"},{status:503});
 try{
  const raw=await req.text();if(raw.length>4096)return NextResponse.json({error:"too_large"},{status:413});
  const response=await fetch(new URL("/demo/units/"+id+"/aliases",base),{method:"PUT",headers:{"X-Demo-Access":token,"Content-Type":"application/json"},body:raw,cache:"no-store",redirect:"error",signal:AbortSignal.timeout(20000)});
  if(!response.ok)return NextResponse.json({error:"unit_request_failed"},{status:response.status});
  return NextResponse.json(await response.json(),{headers:{"Cache-Control":"no-store"}});
 }catch{return NextResponse.json({error:"unit_request_failed"},{status:502});}
}
