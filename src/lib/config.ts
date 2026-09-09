/**
 * Central configuration. The console has exactly one external dependency:
 * the "Agent Status" tab of the Leads Log spreadsheet, where every agent
 * machine's heartbeat reporter lands its rows (via the Sales Console's
 * /api/agents/heartbeat — or this app's own, they write the same tab).
 */
export const config = {
  // The Leads Log spreadsheet — heartbeats live in its "Agent Status" tab.
  sheetId: process.env.SHEET_ID || "1sdOeaChihEjAQBCi8U0_lTTlYP4H38eiC6zgmRLoWC0",

  // Google service account (share the Leads Log with this email as Editor).
  googleClientEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "",
  // Netlify keeps the quotes a .env line carries; dotenv strips them. Accept both.
  googlePrivateKey: (process.env.GOOGLE_PRIVATE_KEY || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\n/g, "\n"),

  // Shared team passcode gating the whole app (same model as the Sales App).
  accessKey: process.env.BLP_APP_ACCESS_KEY || "",

  // Key heartbeat reporters use on POST /api/agents/heartbeat (x-blp-key).
  heartbeatKey: process.env.BLP_AGENT_KEY || "",

  // Agent Gateway — the bridge to the Hermes agents on Karmel's Mac
  // (scripts/agent-gateway.mjs behind the Cloudflare tunnel).
  gatewayUrl: process.env.BLP_GATEWAY_URL || "https://agents.brighamlarsonpianos.com",
  gatewayKey: process.env.BLP_GATEWAY_KEY || "",

  // Google sign-in (domain-restricted OAuth, same model as the Sales App).
  googleOauthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
  googleOauthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
  googleAllowedDomain: process.env.GOOGLE_ALLOWED_DOMAIN || "brighamlarsonpianos.com",
  googleAllowedEmails: (process.env.GOOGLE_ALLOWED_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "http://localhost:8873",
};
