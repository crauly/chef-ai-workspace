// Operator gate only: no user accounts or browser-side backend secrets.
export async function previewAuthorized(req: Request): Promise<boolean> {
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
