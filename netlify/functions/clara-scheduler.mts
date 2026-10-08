/**
 * SCHEDULED function: Netlify fires this at :00 and :30 every hour (UTC cron).
 * Converts "now" to America/Denver and starts whichever of Clara's tasks
 * (src/lib/clara-tasks.ts) are due — her 7:00 Mon–Fri Daily Brief for Brigham.
 * Same pattern as arnold-scheduler.mts; kill switch CLARA_SCHEDULE_PAUSED=1.
 */
import { dueTasks, schedulePaused, startTask } from "../../src/lib/clara-tasks";
import { denver } from "../../src/lib/arnold-tasks";

export default async (req: Request) => {
  const { next_run } = (await req.json().catch(() => ({}))) as { next_run?: string };
  const now = denver();
  const due = dueTasks();
  const started: { task: string; jobId?: number; error?: string }[] = [];
  for (const t of due) {
    try { const job = await startTask(t.id, "Scheduler"); started.push({ task: t.id, jobId: job?.id }); }
    catch (e) { started.push({ task: t.id, error: e instanceof Error ? e.message : String(e) }); }
  }
  console.log(`[clara-scheduler] ${now.stamp} paused=${schedulePaused()} due=${due.map((t) => t.id).join(",") || "none"} started=${JSON.stringify(started)} next=${next_run || "?"}`);
  return new Response(JSON.stringify({ now: now.stamp, due: due.map((t) => t.id), started }), { headers: { "content-type": "application/json" } });
};

export const config = { schedule: "0,30 * * * *" };
