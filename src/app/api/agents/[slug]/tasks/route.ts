import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireSessionOrKey } from "@/lib/api";
import { supa } from "@/lib/supa";
import { AGENT, TASKS, denver, dueTasks } from "@/lib/arnold-tasks";
import type { Job } from "@/lib/agent-brain";

export const dynamic = "force-dynamic";

/** GET /api/agents/arnold/tasks → the cloud schedule, Denver time now, and the last runs. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const g = requireSessionOrKey(req); if (g) return g;
  const { slug } = await ctx.params;
  if (slug !== AGENT) return NextResponse.json({ error: "Only Arnold has cloud tasks so far" }, { status: 404 });
  try {
    const runs = await supa<Job[]>(`agent_jobs?agent=eq.${AGENT}&kind=eq.task&order=id.desc&limit=12`);
    return NextResponse.json({
      now: denver(), dueNow: dueTasks().map((t) => t.id),
      tasks: Object.values(TASKS).map((t) => ({ id: t.id, title: t.title, times: t.times.map((x) => `${x.hour}:${String(x.minute).padStart(2, "0")}`), days: t.days, postToTeam: t.postToTeam, summary: t.summary })),
      runs: runs.map((j) => ({ id: j.id, task: j.payload?.task, who: j.who, status: j.status, result: j.result?.status, telegram: Boolean(j.result?.telegramMessageIds?.length), vaultCommit: j.result?.vaultCommit, error: j.error, created_at: j.created_at, finished_at: j.finished_at })),
    });
  } catch (e) { return jsonError(e); }
}
