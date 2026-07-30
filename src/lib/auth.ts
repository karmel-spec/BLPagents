import crypto from "crypto";
import { config } from "./config";

/**
 * Shared-passcode auth (same model as the Sales App): one team passcode in
 * BLP_APP_ACCESS_KEY. The session cookie stores an HMAC of the passcode so
 * rotating the env var invalidates all sessions. If no passcode is configured
 * the app runs open (local dev).
 */

export const SESSION_COOKIE = "blpagents_session";

export function sessionToken(): string {
  return crypto.createHmac("sha256", "blp-agents-session").update(config.accessKey).digest("hex");
}

export function checkPasscode(passcode: string): boolean {
  if (!config.accessKey) return true;
  const a = Buffer.from(passcode);
  const b = Buffer.from(config.accessKey);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sessionSecret(): string {
  return config.accessKey || "blp-agents-open-mode";
}

/** Signed, named session for Google-authenticated teammates: g.<payload>.<sig> */
export function googleSessionToken(name: string, email: string): string {
  const payload = Buffer.from(
    JSON.stringify({ n: name, e: email, exp: Date.now() + 30 * 86400_000 })
  ).toString("base64url");
  const sig = crypto.createHmac("sha256", sessionSecret()).update(`g.${payload}`).digest("hex");
  return `g.${payload}.${sig}`;
}

export function parseGoogleSession(cookieValue: string | undefined): { name: string; email: string } | null {
  if (!cookieValue?.startsWith("g.")) return null;
  const [, payload, sig] = cookieValue.split(".");
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", sessionSecret()).update(`g.${payload}`).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as { n: string; e: string; exp: number };
    if (data.exp < Date.now()) return null;
    return { name: data.n, email: data.e };
  } catch {
    return null;
  }
}

export function isValidSession(cookieValue: string | undefined): boolean {
  if (!config.accessKey) return true; // open mode
  if (cookieValue === sessionToken()) return true; // shared passcode
  return parseGoogleSession(cookieValue) !== null; // named Google session
}

/** Key heartbeat reporters present on POST /api/agents/heartbeat. */
export function isValidHeartbeatKey(headerValue: string | null): boolean {
  if (!config.heartbeatKey) return false;
  if (!headerValue) return false;
  const a = Buffer.from(headerValue);
  const b = Buffer.from(config.heartbeatKey);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
