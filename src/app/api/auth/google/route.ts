import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { safeNext } from "@/lib/embed-origins";

export const dynamic = "force-dynamic";

/** Kick off Google sign-in: redirect to Google's consent screen. */
export async function GET(req: NextRequest) {
  if (!config.googleOauthClientId) {
    return NextResponse.json({ error: "Google sign-in not configured (GOOGLE_OAUTH_CLIENT_ID)" }, { status: 501 });
  }
  const params = new URLSearchParams({
    client_id: config.googleOauthClientId,
    redirect_uri: `${config.publicBaseUrl}/api/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    hd: config.googleAllowedDomain, // hint Google to the workspace domain
    prompt: "select_account",
  });
  const next = safeNext(req.nextUrl.searchParams.get("next"));
  if (next !== "/") params.set("state", next);
  return NextResponse.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
}
