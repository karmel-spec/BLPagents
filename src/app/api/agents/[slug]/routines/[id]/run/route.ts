import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireSessionOrKey } from "@/lib/api";
import { parseGoogleSession, SESSION_COOKIE } from "@/lib/auth";
import { getAgent } from "@/lib/agents";
import { agentReady } from "@/lib/agent-brain";
import { getRoutine, startRoutine } from "@/lib/routines";

export const dynamic = "force-dynamic";
export const maxDuration = 26;

/** POST → run this routine now (background on Netlify; poll /api/agents/<slug>/chat/jobs/<jobId>). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const g = requireSessionOrKey(req); if (g) return g;
  const { slug, id } = await ctx.params;
  if (!getAgent(slug)) return NextResponse.json({ error: "Unknown agent" }, { status: 404 });
  try {
    const r = await getRoutine(Number(id));
    if (!r || r.agent !== slug) return NextResponse.json({ error: "No such routine" }, { status: 404 });
    if (!agentReady(slug)) return NextResponse.json({ error: `${slug}'s engine isn't configured on this deployment` }, { status: 503 });
    const who = parseGoogleSession(req.cookies.get(SESSION_COOKIE)?.value)?.name || "Team";
    const job = await startRoutine(r, who);
    return NextResponse.json({ jobId: job?.id, status: job?.status, summary: job?.result?.summary, error: job?.error || undefined });
  } catch (e) { return jsonError(e, 502); }
}
