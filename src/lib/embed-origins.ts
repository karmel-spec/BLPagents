/**
 * Origins that may open or frame an agent chat, and call the chat API.
 * The Marketing Engine (blpmarketing.netlify.app) is the one that adds
 * "Ask Eddy" on video cards. Popup windows are first-party on this site, so
 * the session cookie is sent. An iframe on another origin is third-party and
 * browsers will often drop the cookie — use window.open or a normal link.
 */
export const EMBED_ORIGINS = [
  "https://blpmarketing.netlify.app",
  "https://blpstoremap.netlify.app",
  "https://blpsalesapp.netlify.app",
  "https://blpagents.netlify.app",
  "http://localhost:8873",
  "http://127.0.0.1:8873",
] as const;

export function isEmbedOrigin(origin: string): boolean {
  return (EMBED_ORIGINS as readonly string[]).includes(origin);
}

/** CSP for /agents/<slug>/chat so the Marketing Engine (and the other BLP apps) may iframe it. */
export const FRAME_ANCESTORS = `frame-ancestors 'self' ${EMBED_ORIGINS.join(" ")}`;

/** Internal path + query only. Rejects protocol-relative and off-site redirects. */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return "/";
  if (raw.length > 1800) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || raw.includes("\n") || raw.includes("\r")) return "/";
  try {
    const u = new URL(raw, "https://blpagents.netlify.app");
    if (u.origin !== "https://blpagents.netlify.app") return "/";
    return u.pathname + u.search;
  } catch {
    return "/";
  }
}
