// Shared trust boundary for server-to-backend fetches (SSOT for the
// backend origin allow-list). The base URL comes only from trusted server
// env, never from user input: no caller can steer the host. Paths are fixed
// per route and query values are URL-encoded; redirects are always "error".
//
// Allowed origins:
// - https: any host (public Render / Vercel backend origin).
// - http: loopback only (local mock via FASTAPI_BASE_URL), plus the exact
//   operator-configured internal binding host from CHEF_FASTAPI_INTERNAL_URL
//   (Render private address or Vercel service mesh, both HTTP-only by
//   platform design). Arbitrary HTTP hosts are never reachable: the
//   FASTAPI_BASE_URL fallback already admits loopback prefixes only, so an
//   http: URL arrives here solely from loopback or the internal binding.
// - Credentials embedded in the URL are always rejected.
export function backendBase(): string | undefined {
  const internal = process.env.CHEF_FASTAPI_INTERNAL_URL;
  if (internal) return internal;
  const fallback = process.env.FASTAPI_BASE_URL;
  if (fallback && (fallback.startsWith("http://127.0.0.1:") || fallback.startsWith("http://localhost:"))) return fallback;
  return undefined;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function backendUrl(): URL | undefined {
  const raw = backendBase();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.username || url.password) return undefined;
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" &&
    (LOOPBACK.has(url.hostname) || raw === process.env.CHEF_FASTAPI_INTERNAL_URL)) return url;
  return undefined;
}
