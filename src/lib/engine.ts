/**
 * Which engine answers for an agent (Brigham, 2026-10-08: every BLP agent
 * moves from Hermes to a Grok Bot — xAI's cloud "Bot" teammates).
 *
 *   grokbot  the agent's Grok Bot. Grok Bot has no public chat API, but a Bot
 *            routine can be woken by an HTTP webhook and a Bot can call a
 *            remote MCP server — so the console wakes the Bot with the job and
 *            the Bot answers through the console's MCP server (see grokbot.ts).
 *   claude   the in-code runner in agent-brain.ts (vault mind + Claude API).
 *            Stays as the fallback until an agent's Bot is wired, and for any
 *            agent whose Bot is paused.
 *
 * Env per agent (Netlify site blpagents; never in the vault or chat):
 *   GROKBOT_WEBHOOK_URL_<SLUG>   the Bot routine's webhook URL (Grok Bot app → routine → trigger: Webhook)
 *   GROKBOT_WEBHOOK_KEY_<SLUG>   the bearer key that routine expects (optional if the URL carries its own secret)
 *   GROKBOT_CALLBACK_KEY_<SLUG>  what the Bot presents to /api/mcp/<slug> and /api/agents/<slug>/reply
 *                                (falls back to GROKBOT_CALLBACK_KEY, one key for the whole fleet)
 *   AGENT_ENGINE_<SLUG>          "grokbot" | "claude" — force one (default: grokbot when the webhook URL is set)
 *   GROKBOT_WAIT_MINUTES         how long a woken Bot has to answer before the job is marked failed (default 10)
 * No import from the rest of the app, so anything may import this.
 */
import crypto from "crypto";

export type Engine = "grokbot" | "claude" | "bridge";
/** Agents with their own earlier Grok Bot bridge in this repo (grokbot.ts = Ivory; grokbot-bridge.ts PROFILES = Chris, Eddy). The relay leaves them alone. */
export const BESPOKE_BRIDGE_SLUGS = new Set(["ivory", "chris", "ed"]);

const up = (slug: string) => slug.toUpperCase().replace(/-/g, "_");
const env = (name: string) => (process.env[name] || "").trim();

export const grokbotWebhookUrl = (slug: string) => env(`GROKBOT_WEBHOOK_URL_${up(slug)}`);
export const grokbotWebhookKey = (slug: string) => env(`GROKBOT_WEBHOOK_KEY_${up(slug)}`);
export const grokbotCallbackKey = (slug: string) => env(`GROKBOT_CALLBACK_KEY_${up(slug)}`) || env("GROKBOT_CALLBACK_KEY");
export const grokbotConfigured = (slug: string) => Boolean(grokbotWebhookUrl(slug));
export const grokbotWaitMs = () => Math.max(1, Number(process.env.GROKBOT_WAIT_MINUTES) || 10) * 60_000;

export function engineFor(slug: string): Engine {
  if (BESPOKE_BRIDGE_SLUGS.has(slug)) return "bridge";
  const forced = env(`AGENT_ENGINE_${up(slug)}`).toLowerCase();
  if (forced === "grokbot" || forced === "claude") return forced;
  return grokbotConfigured(slug) ? "grokbot" : "claude";
}

export const ENGINE_LABEL: Record<Engine, string> = {
  grokbot: "Grok Bot (via the Agent Console relay)",
  claude: "Agent Console in-app runner (vault mind + Claude API)",
  bridge: "Grok Bot (per-agent bridge: Ivory / Cristofori GrokBot / Eddy Bot)",
};

/** Constant-time check of the key a Bot presents (Authorization: Bearer … or x-blp-key). */
export function callbackKeyOk(slug: string, given: string | null | undefined): boolean {
  const want = grokbotCallbackKey(slug);
  const got = (given || "").replace(/^Bearer\s+/i, "").trim();
  if (!want || !got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
