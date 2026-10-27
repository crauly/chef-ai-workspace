import { NextRequest, NextResponse } from "next/server";
const api=process.env.FASTAPI_BASE_URL;const key=process.env.DEMO_ACCESS_TOKEN;
export async function POST(req:NextRequest,{params}:{params:Promise<{id:string}>}){
 if(!api||!key)return NextResponse.json({error:"Demo backend not configured"},{status:503});
 const {id}=await params;
 if(!/^[0-9a-f-]{36}$/i.test(id))return NextResponse.json({error:"Invalid recipe ID"},{status:400});
 const r=await fetch(new URL("/demo/recipes/"+encodeURIComponent(id)+"/confirm",api),{method:"POST",headers:{"X-Demo-Access":key,"Content-Type":"application/json"},body:await req.text(),cache:"no-store"});
 return new NextResponse(await r.text(),{status:r.status,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
}
