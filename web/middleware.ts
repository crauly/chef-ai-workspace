import {NextRequest, NextResponse} from "next/server";
import {previewAuthorized} from "./preview-access";
export async function middleware(req: NextRequest) {
  if (!await previewAuthorized(req)) return new NextResponse("Protected Chef AI preview", {
    status: 401, headers: {"WWW-Authenticate": 'Basic realm="Chef AI preview", charset="UTF-8"', "Cache-Control": "no-store"},
  });
  const response = NextResponse.next();
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "same-origin");
  return response;
}
// Binary audio has its own identical Basic gate and security headers in the route.
// Avoid Next 15 Node middleware's request-body cloning race for audio uploads.
export const config = {runtime: "nodejs", matcher: ["/((?!_next/static|_next/image|favicon.ico|api/voice/transcribe|api/cron/price-research).*)"]};
