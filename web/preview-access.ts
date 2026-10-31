// Operator gate only: no user accounts or browser-side backend secrets.
export async function previewAuthorized(req: Request): Promise<boolean> {
  // Local UI development has no operator-password prompt. Never bypass in production,
  // even if a production request uses a loopback Host header.
  const url = new URL(req.url);
  if (process.env.NODE_ENV === "development" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      (req.headers.get("host")?.split(":")[0] === url.hostname)) return true;
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
