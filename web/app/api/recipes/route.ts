import { NextRequest, NextResponse } from "next/server";
const api = process.env.FASTAPI_BASE_URL;
const key = process.env.DEMO_ACCESS_TOKEN;
async function forward(req: NextRequest) {
 if (!api || !key) return NextResponse.json({error:"Demo backend not configured"},{status:503});
 const upstream=await fetch(new URL("/demo/recipes"+req.nextUrl.search,api),{
   method:req.method,headers:{"X-Demo-Access":key,...(req.method==="POST"?{"Content-Type":"application/json"}:{})},
   body:req.method==="POST"?await req.text():undefined,cache:"no-store"
 });
 return new NextResponse(await upstream.text(),{status:upstream.status,headers:{"Content-Type":"application/json","Cache-Control":"no-store"}});
}
export const GET=forward;export const POST=forward;
