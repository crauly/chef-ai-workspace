import {NextRequest, NextResponse} from "next/server";
import {previewAuthorized} from "../../preview-access";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Action = "" | "/cost" | "/confirm" | "/propose" | "/corrections";
function failure(status: number) {
  return NextResponse.json({error: "Workspace request failed"}, {status, headers: {"Cache-Control": "no-store"}});
}
// Recheck access at the privileged proxy, independently of middleware.
export async function forward(req: NextRequest, id?: string, action: Action = "") {
  if (!await previewAuthorized(req)) return failure(403);
  if (id !== undefined && !uuid.test(id)) return failure(400);
  if (req.method === "POST" && req.headers.get("origin") !== req.nextUrl.origin) return failure(403);
  const api = process.env.FASTAPI_BASE_URL;
  const key = process.env.DEMO_ACCESS_TOKEN;
  if (!api || !key) return failure(503);
  try {
    const base = new URL(api);
    if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname))) return failure(503);
    const body = req.method === "POST" ? await req.text() : undefined;
    if (body && new TextEncoder().encode(body).length > 65536) return failure(413);
    const path = "/demo/recipes" + (id ? "/" + encodeURIComponent(id) + action : "");
    const url = new URL(path, base);
    if (!id) for (const name of ["page", "page_size"]) {
      const value = req.nextUrl.searchParams.get(name);
      if (value) url.searchParams.set(name, value);
    }
    const response = await fetch(url, {
      method: req.method, headers: {"X-Demo-Access": key, "Content-Type": "application/json"},
      body, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30000),
    });
    // Do not reflect backend/provider errors or private response headers.
    if (!response.ok) return failure(response.status >= 400 && response.status < 600 ? response.status : 502);
    return NextResponse.json(await response.json(), {status: response.status, headers: {"Cache-Control": "no-store"}});
  } catch {return failure(502);}
}
