import { NextRequest, NextResponse } from "next/server";
import { isValidSession, SESSION_COOKIE } from "./auth";

/** Session guard for API routes. Returns a 401 response, or null if OK. */
export function requireSession(req: NextRequest): NextResponse | null {
  if (isValidSession(req.cookies.get(SESSION_COOKIE)?.value)) return null;
  return NextResponse.json({ error: "Unauthorized — sign in with the team passcode" }, { status: 401 });
}

export function jsonError(err: unknown, status = 500): NextResponse {
  const message = err instanceof Error ? err.message : String(err);
  return NextResponse.json({ error: message }, { status });
}
