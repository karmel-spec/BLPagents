import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { isValidSession, SESSION_COOKIE } from "./auth";
import { config } from "./config";

/** Session guard for API routes. Returns a 401 response, or null if OK. */
export function requireSession(req: NextRequest): NextResponse | null {
  if (isValidSession(req.cookies.get(SESSION_COOKIE)?.value)) return null;
  return NextResponse.json({ error: "Unauthorized — sign in with the team passcode" }, { status: 401 });
}

export function jsonError(err: unknown, status = 500): NextResponse {
  const message = err instanceof Error ? err.message : String(err);
  return NextResponse.json({ error: message }, { status });
}

/** True when the request carries the team key (x-blp-key header or ?key=) — for scripts, curl and the scheduler. */
export function hasTeamKey(req: NextRequest): boolean {
  if (!config.accessKey) return true;
  const given = req.headers.get("x-blp-key") || req.nextUrl.searchParams.get("key") || "";
  const a = Buffer.from(given);
  const b = Buffer.from(config.accessKey);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Session cookie OR team key. */
export function requireSessionOrKey(req: NextRequest): NextResponse | null {
  if (hasTeamKey(req)) return null;
  return requireSession(req);
}
