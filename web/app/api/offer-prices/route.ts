import {NextRequest,NextResponse} from "next/server";
import {previewAuthorized,sameOrigin} from "../../../preview-access";
import {backendUrl} from "../backend-url";

// An explicit user action only. The server RPC checks ownership, unit,
// ingredient and supplier, and writes the observation+adoption atomically.
export async function POST(req:NextRequest){
 if(!await previewAuthorized(req)||!sameOrigin(req))
  return NextResponse.json({error:"forbidden"},{status:403});
 const base=backendUrl(),token=process.env.DEMO_ACCESS_TOKEN;
 if(!base||!token)return NextResponse.json({error:"unavailable"},{status:503});
 try{
  const raw=await req.text();
  if(raw.length>4096)return NextResponse.json({error:"too_large"},{status:413});
  const response=await fetch(new URL("/demo/offer-prices",base),{
   method:"POST",headers:{"X-Demo-Access":token,"Content-Type":"application/json"},
   body:raw,cache:"no-store",redirect:"error",signal:AbortSignal.timeout(20000)
  });
  if(!response.ok)return NextResponse.json({error:"offer_price_failed"},{status:response.status});
  return NextResponse.json(await response.json(),{status:201,headers:{"Cache-Control":"no-store"}});
 }catch{return NextResponse.json({error:"offer_price_failed"},{status:502});}
}
