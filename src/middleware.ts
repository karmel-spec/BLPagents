import { NextRequest, NextResponse } from "next/server";

/**
 * Gate all pages behind the team passcode session cookie. Exceptions:
 * /login, the auth API, and the heartbeat endpoint (which authenticates
 * itself with the agent key). API routes 401 server-side via requireSession.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const open =
    pathname === "/login" ||
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/api/agents/heartbeat") ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico";
  if (open) return NextResponse.next();

  const hasSession = Boolean(req.cookies.get("blpagents_session")?.value);
  const isApi = pathname.startsWith("/api/");
  if (!hasSession && !isApi && process.env.BLP_APP_ACCESS_KEY) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
