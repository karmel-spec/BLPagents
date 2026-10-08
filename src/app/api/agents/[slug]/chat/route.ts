import { NextRequest, NextResponse } from "next/server";
import { requireSession, jsonError } from "@/lib/api";
import { parseGoogleSession, SESSION_COOKIE } from "@/lib/auth";
import { getAgent } from "@/lib/agents";
import { brainConfigured, chatEnabled, history, searchThread, createJob, kickBackground, runJob, onNetlify } from "@/lib/agent-brain";
import { bridgeFor, sanitizeContext } from "@/lib/grokbot-bridge";
import { supaConfigured } from "@/lib/supa";

export const dynamic = "force-dynamic";
export const maxDuration = 26;

const SLUG = /^[a-z0-9-]{1,40}$/;
function whoIs(req: NextRequest): { who: string; email: string } {
  const g = parseGoogleSession(req.cookies.get(SESSION_COOKIE)?.value);
  return g ? { who: g.name, email: g.email } : { who: "Team", email: "" };
}

/** GET → the shared thread with this agent (same rows the Store Map chat reads). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const guard = requireSession(req);
  if (guard) return guard;
  const { slug } = await ctx.params;
  if (!SLUG.test(slug) || !getAgent(slug)) return NextResponse.json({ error: "Unknown agent" }, { status: 404 });
  try {
    if (!chatEnabled(slug)) return NextResponse.json({ enabled: false, messages: [] });
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
    } else if (!brainConfigured()) {
      return NextResponse.json({ enabled: true, configured: false, messages: [], viewer, error: "In-app chat needs ANTHROPIC_API_KEY, VAULT_GITHUB_TOKEN and SUPABASE_* on this deployment" });
    }
    const limit = Math.min(200, Math.max(10, Number(req.nextUrl.searchParams.get("limit") || 60)));
    const q = (req.nextUrl.searchParams.get("q") || "").trim();
    const messages = q.length >= 2 ? await searchThread(slug, q, limit) : await history(slug, limit);
    return NextResponse.json({ enabled: true, configured: true, bridged, viewer, messages });
  } catch (err) {
    return jsonError(err);
  }
}

/** POST {message} → queue a reply. On Netlify the work runs in the background and the page polls /chat/jobs/:id. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const guard = requireSession(req);
  if (guard) return guard;
  const { slug } = await ctx.params;
  if (!SLUG.test(slug) || !getAgent(slug) || !chatEnabled(slug)) return NextResponse.json({ error: "This agent has no in-app chat yet" }, { status: 404 });
  try {
    const b = (await req.json().catch(() => ({}))) as { message?: string; app?: string; context?: unknown };
    const message = String(b.message || "").trim();
    if (!message) return NextResponse.json({ error: "Type a message first" }, { status: 400 });
    if (message.length > 6000) return NextResponse.json({ error: "Keep a message under 6,000 characters" }, { status: 400 });
    let { who, email } = whoIs(req);
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
    if (!brainConfigured()) return NextResponse.json({ error: "In-app chat isn't configured on this deployment" }, { status: 503 });
    const jobId = await createJob(slug, who, email, message);
    if (onNetlify()) {
      await kickBackground(jobId);
      return NextResponse.json({ jobId, status: "pending" });
    }
    const job = await runJob(jobId);
    return NextResponse.json({ jobId, status: job?.status, ...(job?.result || {}), error: job?.error || undefined });
  } catch (err) {
    return jsonError(err, 502);
  }
}
