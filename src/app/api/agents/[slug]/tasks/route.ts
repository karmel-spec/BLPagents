import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireSessionOrKey } from "@/lib/api";
import { supa } from "@/lib/supa";
import { denver } from "@/lib/arnold-tasks";
import { taskModule } from "@/lib/agent-tasks";
import type { Job } from "@/lib/agent-brain";

export const dynamic = "force-dynamic";

/** GET /api/agents/<slug>/tasks → the agent's cloud schedule, Denver time now, and the last runs. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const g = requireSessionOrKey(req); if (g) return g;
  const { slug } = await ctx.params;
  const mod = await taskModule(slug);
  if (!mod) return NextResponse.json({ error: `${slug} has no scheduled tasks in the cloud runtime (arnold, clara do)` }, { status: 404 });
  try {
    const runs = await supa<Job[]>(`agent_jobs?agent=eq.${encodeURIComponent(slug)}&kind=eq.task&order=id.desc&limit=12`);
    return NextResponse.json({
      now: denver(), paused: mod.schedulePaused(), dueNow: Object.values(mod.TASKS).filter((t) => { const { hour, minute, day } = denver(); return t.days.includes(day) && t.times.some((x) => x.hour === hour && Math.abs(x.minute - minute) <= 4); }).map((t) => t.id),
      tasks: Object.values(mod.TASKS).map((t) => ({ id: t.id, title: t.title, times: t.times.map((x) => `${x.hour}:${String(x.minute).padStart(2, "0")}`), days: t.days, summary: t.summary })),
      runs: runs.map((j) => ({ id: j.id, task: j.payload?.task, who: j.who, status: j.status, summary: j.result?.summary, telegram: Boolean(j.result?.telegramMessageIds?.length), vaultCommit: j.result?.vaultCommit, error: j.error, started: j.started_at, finished: j.finished_at })),
    });
  } catch (e) { return jsonError(e); }
}
