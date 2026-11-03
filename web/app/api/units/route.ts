import {NextRequest,NextResponse} from "next/server";
import {previewAuthorized,sameOrigin} from "../../../preview-access";
import {backendUrl} from "../backend-url";
export async function GET(req:NextRequest){
 if(!await previewAuthorized(req))return NextResponse.json({error:"forbidden"},{status:403});
 const base=backendUrl(),token=process.env.DEMO_ACCESS_TOKEN;
 if(!base||!token)return NextResponse.json({error:"unavailable"},{status:503});
 try{
  const response=await fetch(new URL("/demo/units",base),{headers:{"X-Demo-Access":token},cache:"no-store",redirect:"error",signal:AbortSignal.timeout(20000)});
  if(!response.ok)return NextResponse.json({error:"unit_request_failed"},{status:response.status});
  return NextResponse.json(await response.json(),{headers:{"Cache-Control":"no-store"}});
 }catch{return NextResponse.json({error:"unit_request_failed"},{status:502});}
}
