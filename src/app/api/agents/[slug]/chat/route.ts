import { NextRequest, NextResponse } from "next/server";
import { requireSession, jsonError } from "@/lib/api";
import { parseGoogleSession, SESSION_COOKIE } from "@/lib/auth";
import { getAgent } from "@/lib/agents";
import { brainConfigured, chatEnabled, history, createJob, kickBackground, runJob, onNetlify } from "@/lib/agent-brain";

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
    if (!brainConfigured()) return NextResponse.json({ enabled: true, configured: false, messages: [], error: "In-app chat needs ANTHROPIC_API_KEY, VAULT_GITHUB_TOKEN and SUPABASE_* on this deployment" });
    const limit = Math.min(200, Math.max(10, Number(req.nextUrl.searchParams.get("limit") || 60)));
    return NextResponse.json({ enabled: true, configured: true, messages: await history(slug, limit) });
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
    if (!brainConfigured()) return NextResponse.json({ error: "In-app chat isn't configured on this deployment" }, { status: 503 });
    const b = (await req.json().catch(() => ({}))) as { message?: string };
    const message = String(b.message || "").trim();
    if (!message) return NextResponse.json({ error: "Type a message first" }, { status: 400 });
    if (message.length > 6000) return NextResponse.json({ error: "Keep a message under 6,000 characters" }, { status: 400 });
    const { who, email } = whoIs(req);
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
