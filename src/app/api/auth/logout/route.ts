import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** Clear the session cookie and land back on the login page. */
export async function GET(req: NextRequest) {
  const res = NextResponse.redirect(new URL("/login", req.nextUrl.origin));
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", maxAge: 0, path: "/" });
  return res;
}
