// Same-origin check for POST/probe routes. Production requires an exact match.
// In development, Next normalizes req.url to the bind address (localhost),
// so a loopback page origin is accepted when the Host header is loopback too.
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return false; }
  const url = new URL(req.url);
  if (parsed.origin === url.origin) return true;
  if (process.env.NODE_ENV !== "development") return false;
  const loopback = (name: string) => name === "localhost" || name === "127.0.0.1";
  return loopback(parsed.hostname) && parsed.port === url.port &&
    loopback(req.headers.get("host")?.split(":")[0] ?? "");
}

// Operator gate only: no user accounts or browser-side backend secrets.
export async function previewAuthorized(req: Request): Promise<boolean> {
  // Local UI development has no operator-password prompt. Never bypass in production,
  // even if a production request uses a loopback Host header.
  const url = new URL(req.url);
  // Next dev reports the bind address (localhost) in req.url regardless of the
  // client's Host header, so each side is checked for loopback independently.
  // Development-only; production still requires the preview password below.
  const loopback = (name: string) => name === "localhost" || name === "127.0.0.1";
  if (process.env.NODE_ENV === "development" &&
      loopback(url.hostname) &&
      loopback(req.headers.get("host")?.split(":")[0] ?? "")) return true;
  const secret = process.env.DEMO_PREVIEW_PASSWORD;
  if (!secret || secret.length < 24) return false;
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Basic ")) return false;
  try {
    const decoded = atob(header.slice(6));
    const digest = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    const [a, b] = await Promise.all([digest(decoded), digest("chef:" + secret)]);
    const left = new Uint8Array(a), right = new Uint8Array(b);
    let difference = 0;
    for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
    return difference === 0;
  } catch {return false;}
}
