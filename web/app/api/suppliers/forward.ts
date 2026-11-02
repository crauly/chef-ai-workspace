import {NextRequest,NextResponse} from "next/server";
import {previewAuthorized,sameOrigin} from "../../../preview-access";
import {backendUrl} from "../backend-url";
const fail=(status:number)=>NextResponse.json({error:"supplier_request_failed"},{status});
export async function supplierForward(req:NextRequest,id?:string){
 if(!await previewAuthorized(req))return fail(403);
 if(req.method!=="GET"&&!sameOrigin(req))return fail(403);
 if(id&&!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id))return fail(400);
 const base=backendUrl();
 const token=process.env.DEMO_ACCESS_TOKEN;
 if(!base||!token)return fail(503);
 try{
  const target=new URL("/demo/suppliers"+(id?"/"+id:""),base);
  const body=req.method==="POST"||req.method==="PUT"?await req.text():undefined;
  if(body&&body.length>4096)return fail(413);
  const response=await fetch(target,{method:req.method,headers:{"X-Demo-Access":token,"Content-Type":"application/json"},body,cache:"no-store",redirect:"error",signal:AbortSignal.timeout(20000)});
  if(!response.ok)return fail(response.status);
  if(response.status===204)return new NextResponse(null,{status:204});
  return NextResponse.json(await response.json(),{status:response.status,headers:{"Cache-Control":"no-store"}});
 }catch{return fail(502);}
}
