import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireSessionOrKey } from "@/lib/api";
import { parseGoogleSession, SESSION_COOKIE } from "@/lib/auth";
import { AGENT, TASKS, startTask } from "@/lib/arnold-tasks";

export const dynamic = "force-dynamic";
export const maxDuration = 26;

/**
 * Run one of Arnold's scheduled tasks NOW (team key or console session):
 *   POST /api/agents/arnold/tasks/predraft?key=…   (also: daily-brief, briefing)
 * Returns the job id; poll /api/agents/arnold/chat/jobs/<id>?key=… for the result.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string; task: string }> }) {
  const g = requireSessionOrKey(req); if (g) return g;
  const { slug, task } = await ctx.params;
  if (slug !== AGENT || !TASKS[task]) return NextResponse.json({ error: `Unknown task — Arnold's tasks are ${Object.keys(TASKS).join(", ")}` }, { status: 404 });
  try {
    const who = parseGoogleSession(req.cookies.get(SESSION_COOKIE)?.value)?.name;
    const job = await startTask(task, who ? `Manual run by ${who}` : "Manual run (team key)");
    return NextResponse.json({ jobId: job?.id, status: job?.status, ...(job?.status === "done" || job?.status === "failed" ? { result: job?.result, error: job?.error } : {}) });
  } catch (e) { return jsonError(e, 502); }
}
