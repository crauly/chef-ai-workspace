import {NextRequest, NextResponse} from "next/server";
import {previewAuthorized} from "../../../preview-access";

export const runtime = "nodejs";
const headers = {"Cache-Control": "no-store"};
const fail = (status: number) => NextResponse.json({error: "Realtime ticket failed"}, {status, headers});

// Authenticated server relay: the browser never receives MODEL_API_KEY.
// This proxy reuses the existing preview + DEMO_ACCESS_TOKEN chain and asks
// the Python backend for a single-use ticket.
export async function POST(req: NextRequest) {
  if (!await previewAuthorized(req)) return fail(403);
  if (req.headers.get("origin") !== req.nextUrl.origin) return fail(403);
  const api = process.env.CHEF_FASTAPI_INTERNAL_URL;
  const key = process.env.DEMO_ACCESS_TOKEN;
  if (!api || !key) return fail(503);
  let body = "";
  try {
    body = await req.text();
    if (new TextEncoder().encode(body).length > 4096) return fail(413);
    const parsed: unknown = body ? JSON.parse(body) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail(400);
    const record = parsed as Record<string, unknown>;
    const locale = record.locale === undefined ? "en" : record.locale;
    const context = record.context_terms === undefined ? [] : record.context_terms;
    if (locale !== "en" && locale !== "ja") return fail(400);
    if (!Array.isArray(context) || context.length > 10 ||
      !context.every(t => typeof t === "string" && t.length <= 80)) return fail(400);
  } catch { return fail(400); }
  try {
    const url = new URL("/demo/ws-ticket", api);
    const response = await fetch(url, {
      method: "POST", headers: {"X-Demo-Access": key, "Content-Type": "application/json"},
      body, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return fail(response.status >= 400 && response.status < 600 ? response.status : 502);
    const ticket: unknown = await response.json();
    if (!ticket || typeof ticket !== "object" ||
      typeof (ticket as {ticket?: unknown}).ticket !== "string") return fail(502);
    return NextResponse.json(ticket, {headers});
  } catch { return fail(502); }
}
