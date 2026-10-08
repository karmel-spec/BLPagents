import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireSessionOrKey } from "@/lib/api";
import { parseGoogleSession, SESSION_COOKIE } from "@/lib/auth";
import { taskModule } from "@/lib/agent-tasks";

export const dynamic = "force-dynamic";
export const maxDuration = 26;

/**
 * Run one of an agent's scheduled tasks NOW (team key or console session):
 *   POST /api/agents/arnold/tasks/predraft?key=…   (daily-brief, briefing)
 *   POST /api/agents/clara/tasks/daily-brief?key=…
 * Returns the job id; poll /api/agents/<slug>/chat/jobs/<id>?key=… for the result.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string; task: string }> }) {
  const g = requireSessionOrKey(req); if (g) return g;
  const { slug, task } = await ctx.params;
  const mod = await taskModule(slug);
  if (!mod || !mod.TASKS[task]) return NextResponse.json({ error: mod ? `Unknown task — ${slug}'s tasks are ${Object.keys(mod.TASKS).join(", ")}` : `${slug} has no scheduled tasks in the cloud runtime` }, { status: 404 });
  try {
    const who = parseGoogleSession(req.cookies.get(SESSION_COOKIE)?.value)?.name;
    const job = await mod.startTask(task, who ? `Manual run by ${who}` : "Manual run (team key)");
    return NextResponse.json({ jobId: job?.id, status: job?.status, ...(job?.status === "done" || job?.status === "failed" ? { result: job?.result, error: job?.error } : {}) });
  } catch (e) { return jsonError(e, 502); }
}
