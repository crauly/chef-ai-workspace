import {NextRequest, NextResponse} from "next/server";
import {previewAuthorized} from "../../../preview-access";
const fail = (status: number) => NextResponse.json({error:"Voice command failed"}, {status,headers:{"Cache-Control":"no-store"}});
export async function POST(req: NextRequest) {
  if (!await previewAuthorized(req)) return fail(403);
  if (req.headers.get("origin") !== req.nextUrl.origin) return fail(403);
  const base = process.env.FASTAPI_BASE_URL;
  const token = process.env.DEMO_ACCESS_TOKEN;
  if (!base || !token) return fail(503);
  try {
    const url = new URL(base);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(url.hostname))) return fail(503);
    const body = await req.text();
    if (new TextEncoder().encode(body).length > 4096) return fail(413);
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") return fail(400);
    const record = parsed as Record<string, unknown>;
    if (typeof record.utterance !== "string" || !record.utterance.trim() || record.utterance.length > 1000 ||
        !["idle","create","browse","edit"].includes(String(record.current_mode))) return fail(400);
    const response = await fetch(new URL("/demo/intent",url), {
      method:"POST", headers:{"Content-Type":"application/json","X-Demo-Access":token},
      body:JSON.stringify({utterance:record.utterance,current_mode:record.current_mode}),
      cache:"no-store",redirect:"error",signal:AbortSignal.timeout(23000),
    });
    if (!response.ok) return fail(response.status >= 400 && response.status < 600 ? response.status : 502);
    return NextResponse.json(await response.json(),{headers:{"Cache-Control":"no-store"}});
  } catch {return fail(502);}
}
