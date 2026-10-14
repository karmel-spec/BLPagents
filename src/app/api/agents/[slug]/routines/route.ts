import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireSessionOrKey } from "@/lib/api";
import { parseGoogleSession, SESSION_COOKIE } from "@/lib/auth";
import { getAgent } from "@/lib/agents";
import { chatEnabled } from "@/lib/agent-brain";
import { engineFor } from "@/lib/engine";
import { createRoutine, listRoutines, recentRoutineRuns, routinesPaused } from "@/lib/routines";
import { denver } from "@/lib/arnold-tasks";

export const dynamic = "force-dynamic";
const SLUG = /^[a-z0-9-]{1,40}$/;
const who = (req: NextRequest) => parseGoogleSession(req.cookies.get(SESSION_COOKIE)?.value)?.name || "Team";

/** GET → this agent's team-set routines + last runs. POST {title, prompt, hour, minute, days, deliver} → create. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const g = requireSessionOrKey(req); if (g) return g;
  const { slug } = await ctx.params;
  if (!SLUG.test(slug) || !getAgent(slug)) return NextResponse.json({ error: "Unknown agent" }, { status: 404 });
  try {
    const [routines, runs] = await Promise.all([listRoutines(slug), recentRoutineRuns(slug)]);
    return NextResponse.json({ now: denver(), paused: routinesPaused(), engine: engineFor(slug), chat: chatEnabled(slug), routines, runs: runs.map((j) => ({ id: j.id, routine: j.payload?.routine?.id, title: j.payload?.routine?.title, who: j.who, status: j.status, summary: j.result?.summary, error: j.error, started: j.started_at, finished: j.finished_at })) });
  } catch (e) { return jsonError(e); }
}
export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const g = requireSessionOrKey(req); if (g) return g;
  const { slug } = await ctx.params;
  if (!SLUG.test(slug) || !getAgent(slug) || !chatEnabled(slug)) return NextResponse.json({ error: "This agent has no cloud engine to run routines" }, { status: 404 });
  try {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const r = await createRoutine(slug, b, who(req));
    return NextResponse.json({ routine: r });
  } catch (e) { return jsonError(e, 400); }
}
