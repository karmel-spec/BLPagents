import crypto from "crypto";
import { config } from "./config";

/**
 * Service-account bearer tokens for Google APIs (Sheets, Drive, Docs).
 * JWT signed with node:crypto, plain fetch — no SDK. Cached per scope set.
 */

export class GoogleAuthError extends Error {
  constructor() {
    super(
      "Google access unavailable: set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY, and share the sheet/folder with the service account."
    );
    this.name = "GoogleAuthError";
  }
}

const cache = new Map<string, { token: string; exp: number }>();

export function hasGoogleCreds(): boolean {
  return Boolean(config.googleClientEmail && config.googlePrivateKey);
}

export async function getGoogleToken(scopes: string[]): Promise<string> {
  if (!hasGoogleCreds()) throw new GoogleAuthError();
  const scope = scopes.join(" ");
  const now = Math.floor(Date.now() / 1000);
  const hit = cache.get(scope);
  if (hit && hit.exp > now + 60) return hit.token;

  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      iss: config.googleClientEmail,
      scope,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })
  ).toString("base64url");
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(config.googlePrivateKey).toString("base64url");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status}): ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cache.set(scope, { token: json.access_token, exp: now + json.expires_in });
  return json.access_token;
}

/** Authenticated GET returning JSON; throws with status + body on failure. */
export async function googleGet(url: string, scopes: string[]): Promise<any> {
  const token = await getGoogleToken(scopes);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!res.ok) throw new Error(`${new URL(url).pathname} failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return res.json();
}
