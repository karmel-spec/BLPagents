import { NextRequest, NextResponse } from "next/server";
import { requireSessionOrKey, hasTeamKey, jsonError } from "@/lib/api";
import { parseGoogleSession, SESSION_COOKIE } from "@/lib/auth";
import { getAgent } from "@/lib/agents";
import { agentReady, brainConfigured, chatEnabled, history, searchThread, createJob, kickBackground, runJob, onNetlify } from "@/lib/agent-brain";
import { engineFor } from "@/lib/engine";
import { isGrokbotSlug } from "@/lib/grokbot-shared";
import { deliverToGrokbot, grokbotWebhookConfigured } from "@/lib/grokbot";
import { bridgeFor, sanitizeContext } from "@/lib/grokbot-bridge";
import { supaConfigured } from "@/lib/supa";

export const dynamic = "force-dynamic";
export const maxDuration = 26;

const SLUG = /^[a-z0-9-]{1,40}$/;
/** Who is writing: the Google sign-in; or, for another BLP app calling with the team key, the name/email it vouches for. */
function whoIs(req: NextRequest, b: { who?: string; email?: string } = {}): { who: string; email: string } {
  const g = parseGoogleSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (g) return { who: g.name, email: g.email };
  if (hasTeamKey(req) && b.who) return { who: String(b.who).slice(0, 80), email: String(b.email || "").slice(0, 120) };
  return { who: "Team", email: "" };
}

/** GET → the shared thread with this agent (same rows the Store Map chat reads). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const guard = requireSessionOrKey(req);
  if (guard) return guard;
  const { slug } = await ctx.params;
  if (!SLUG.test(slug) || !getAgent(slug)) return NextResponse.json({ error: "Unknown agent" }, { status: 404 });
  try {
    if (!chatEnabled(slug)) return NextResponse.json({ enabled: false, messages: [] });
    const limit = Math.min(200, Math.max(10, Number(req.nextUrl.searchParams.get("limit") || 60)));
    // Ivory writes her own reply into agent_messages. A missing webhook is not an error.
    if (isGrokbotSlug(slug)) {
      if (!supaConfigured()) return NextResponse.json({ enabled: true, configured: false, provider: "grokbot", webhook: grokbotWebhookConfigured(), messages: [], error: "Ivory's chat thread needs SUPABASE_URL and SUPABASE_SERVICE_KEY on this deployment." });
      return NextResponse.json({ enabled: true, configured: true, provider: "grokbot", webhook: grokbotWebhookConfigured(), messages: await history(slug, limit) });
    }
    const bridge = bridgeFor(slug);
    const bridged = Boolean(bridge?.configured());
    const viewer = whoIs(req);
    if (bridge && !bridged && !bridge.profile.claudeFallback) {
      return NextResponse.json({
        enabled: true,
        configured: false,
        bridged: false,
        messages: [],
        viewer,
        error: `${bridge.profile.agentName}'s chat needs ${bridge.profile.envPrefix}_GROKBOT_WEBHOOK_URL and ${bridge.profile.envPrefix}_GROKBOT_WEBHOOK_KEY on this deployment. There is no Claude fallback.`,
      });
    }
    if (bridged) {
      if (!supaConfigured()) {
        const error = slug === "chris"
          ? "Chris's chat needs SUPABASE_URL and SUPABASE_SERVICE_KEY on this deployment"
          : `${getAgent(slug)?.name || slug}'s chat needs SUPABASE_URL and SUPABASE_SERVICE_KEY on this deployment`;
        return NextResponse.json({ enabled: true, configured: false, bridged: true, messages: [], viewer, error });
      }
    } else if (engineFor(slug) === "grokbot") {
      if (!agentReady(slug)) return NextResponse.json({ enabled: true, configured: false, engine: "grokbot", messages: [], viewer, error: "Grok Bot relay needs SUPABASE_* and VAULT_GITHUB_TOKEN on this deployment" });
    } else if (!brainConfigured()) {
      return NextResponse.json({ enabled: true, configured: false, messages: [], viewer, error: "In-app chat needs ANTHROPIC_API_KEY, VAULT_GITHUB_TOKEN and SUPABASE_* on this deployment" });
    }
    const q = (req.nextUrl.searchParams.get("q") || "").trim();
    const messages = q.length >= 2 ? await searchThread(slug, q, limit) : await history(slug, limit);
    return NextResponse.json({ enabled: true, configured: true, bridged, engine: engineFor(slug), viewer, messages });
  } catch (err) {
    return jsonError(err);
  }
}

/**
 * POST {message} → queue a reply. On Netlify the work runs in the background and the page polls /chat/jobs/:id.
 * Ivory posts to Ivory Grok Bot instead. Eddy and Chris use the Grok Bot bridge. Every other agent goes to the
 * fleet relay (engine grokbot) or the in-app runner (engine claude). Other BLP apps (Store Map, Marketing app)
 * call with the team key and add {who, email, channelNote?, systemNote?}.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const guard = requireSessionOrKey(req);
  if (guard) return guard;
  const { slug } = await ctx.params;
  if (!SLUG.test(slug) || !getAgent(slug) || !chatEnabled(slug)) return NextResponse.json({ error: "This agent has no in-app chat yet" }, { status: 404 });
  try {
    const b = (await req.json().catch(() => ({}))) as { message?: string; source?: string; app?: string; context?: unknown; who?: string; email?: string; channelNote?: string; systemNote?: string };
    const message = String(b.message || "").trim();
    if (!message) return NextResponse.json({ error: "Type a message first" }, { status: 400 });
    if (message.length > 12000) return NextResponse.json({ error: "Keep a message under 12,000 characters" }, { status: 400 });
    let { who, email } = whoIs(req, b);
    if (isGrokbotSlug(slug)) {
      const delivered = await deliverToGrokbot({ slug, who, email, message, source: b.source === "faces-widget" || b.source === "dispatch" ? b.source : "console" });
      return NextResponse.json(delivered);
    }
    const context = sanitizeContext(b.context);
    const bridge = bridgeFor(slug);
    if (bridge?.configured()) {
      // A shared passcode session has no name. The Marketing Engine passes the signed-in teammate as context.user.
      if ((!email || who === "Team") && context?.user) who = context.user.slice(0, 80);
      const app = String(b.app || "Agent Console").trim().slice(0, 120) || "Agent Console";
      const sent = await bridge.acceptApp({ who, email, message, app, context });
      return NextResponse.json({ jobId: sent.jobId, conversation_id: sent.conversation_id, status: "pending", bridged: true });
    }
    if (bridge && !bridge.profile.claudeFallback) {
      return NextResponse.json({ error: `${bridge.profile.agentName}'s webhook isn't configured (${bridge.profile.envPrefix}_GROKBOT_WEBHOOK_URL and ${bridge.profile.envPrefix}_GROKBOT_WEBHOOK_KEY).` }, { status: 503 });
    }
    if (!agentReady(slug)) return NextResponse.json({ error: `${slug}'s engine (${engineFor(slug)}) isn't configured on this deployment` }, { status: 503 });
    const extra = hasTeamKey(req) ? { ...(b.channelNote ? { channelNote: String(b.channelNote).slice(0, 4000) } : {}), ...(b.systemNote ? { systemNote: String(b.systemNote).slice(0, 12000) } : {}) } : {};
    const jobId = await createJob(slug, who, email, message, "chat", extra);
    if (onNetlify()) {
      await kickBackground(jobId);
      return NextResponse.json({ jobId, status: "pending", engine: engineFor(slug) });
    }
    const job = await runJob(jobId);
    return NextResponse.json({ jobId, status: job?.status, engine: engineFor(slug), ...(job?.result || {}), error: job?.error || undefined });
  } catch (err) {
    return jsonError(err, 502);
  }
}
