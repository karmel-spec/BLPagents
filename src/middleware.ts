import { NextRequest, NextResponse } from "next/server";
import { FRAME_ANCESTORS, isEmbedOrigin, safeNext } from "@/lib/embed-origins";

/**
 * Gate all pages behind the team passcode session cookie. Exceptions:
 * /login, the auth API, and the heartbeat endpoint (which authenticates
 * itself with the agent key). API routes 401 server-side via requireSession.
 *
 * Chat pages and assistant.js allow the Marketing Engine (and the other BLP
 * apps) to frame or fetch them. See embed-origins.ts.
 */
function corsPath(pathname: string): boolean {
  if (pathname === "/assistant.js") return true;
  if (/^\/api\/agents\/[^/]+\/chat(\/|$)/.test(pathname)) return true;
  if (/^\/agents\/[^/]+\/chat\/?$/.test(pathname)) return true;
  return false;
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
  };
}

function decorate(res: NextResponse, req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;
  const origin = req.headers.get("origin");
  if (origin && isEmbedOrigin(origin) && corsPath(pathname)) {
    for (const [k, v] of Object.entries(corsHeaders(origin))) res.headers.set(k, v);
  }
  if (/^\/agents\/[^/]+\/chat\/?$/.test(pathname)) res.headers.set("Content-Security-Policy", FRAME_ANCESTORS);
  return res;
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS" && origin && isEmbedOrigin(origin) && corsPath(pathname)) {
    return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
  }

  // Static files (assistant.js widget, portraits, logo) must load from other
  // BLP apps where nobody is signed in to the console — only pages are gated.
  const isStaticAsset = /\.(js|png|jpe?g|svg|ico|css|webp)$/i.test(pathname);
  const open =
    isStaticAsset ||
    pathname === "/login" ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/agents/heartbeat") ||
    pathname.startsWith("/.netlify") || // background functions authenticate with the team key themselves
    pathname.startsWith("/_next");
  if (open) return decorate(NextResponse.next(), req);

  const hasSession = Boolean(req.cookies.get("blpagents_session")?.value);
  const isApi = pathname.startsWith("/api/");
  if (!hasSession && !isApi && process.env.BLP_APP_ACCESS_KEY) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    const next = safeNext(pathname + req.nextUrl.search);
    if (next !== "/") url.searchParams.set("next", next);
    return NextResponse.redirect(url);
  }
  return decorate(NextResponse.next(), req);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
