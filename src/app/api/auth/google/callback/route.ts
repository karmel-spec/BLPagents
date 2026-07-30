import { NextRequest, NextResponse } from "next/server";
import { config } from "@/lib/config";
import { googleSessionToken, SESSION_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";

function denied(reason: string): NextResponse {
  return new NextResponse(
    `<!doctype html><body style="font-family:sans-serif;padding:40px"><h2>Sign-in not allowed</h2><p>${reason}</p><p><a href="/login">Back to login</a></p></body>`,
    { status: 403, headers: { "Content-Type": "text/html" } }
  );
}

/**
 * Google OAuth callback: exchange the code, check the account belongs to the
 * BLP workspace (or the explicit allowlist), then set a signed session cookie
 * carrying the teammate's name.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  if (!code) return denied("Google didn't return a sign-in code.");
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: config.googleOauthClientId,
        client_secret: config.googleOauthClientSecret,
        redirect_uri: `${config.publicBaseUrl}/api/auth/google/callback`,
        grant_type: "authorization_code",
      }),
    });
    if (!res.ok) return denied(`Token exchange failed (${res.status}).`);
    const tokens = (await res.json()) as { id_token?: string };
    if (!tokens.id_token) return denied("No identity token returned.");

    // The id_token came straight from Google over the server-to-server
    // exchange, so decoding (with an audience check) is sufficient.
    const claims = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64url").toString()) as {
      aud: string;
      email: string;
      email_verified: boolean;
      given_name?: string;
      name?: string;
      hd?: string;
    };
    if (claims.aud !== config.googleOauthClientId) return denied("Token audience mismatch.");
    if (!claims.email_verified) return denied("Google account email is not verified.");

    const email = claims.email.toLowerCase();
    const domainOk = email.endsWith(`@${config.googleAllowedDomain}`);
    const allowlisted = config.googleAllowedEmails.includes(email);
    if (!domainOk && !allowlisted) {
      return denied(`${claims.email} isn't a ${config.googleAllowedDomain} account. Ask Karmel to add you.`);
    }

    const firstName = (claims.given_name || claims.name || email.split("@")[0]).split(" ")[0];
    const response = NextResponse.redirect(`${config.publicBaseUrl}/`);
    response.cookies.set(SESSION_COOKIE, googleSessionToken(firstName, email), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 60 * 60 * 24 * 30,
      path: "/",
    });
    return response;
  } catch (err) {
    return denied(err instanceof Error ? err.message : String(err));
  }
}
