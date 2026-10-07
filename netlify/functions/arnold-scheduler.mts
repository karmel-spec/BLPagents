/**
 * SCHEDULED function: Netlify fires this at :00 and :30 every hour (UTC cron).
 * It converts "now" to America/Denver and starts whichever of Arnold's tasks
 * (src/lib/arnold-tasks.ts) are due at that wall-clock time — so 8:00 is 8:00
 * in Utah whether it's MDT or MST. Each task becomes a background job; this
 * function itself finishes in a second or two.
 */
import { dueTasks, denver, startTask } from "../../src/lib/arnold-tasks";

export default async (req: Request) => {
  const { next_run } = (await req.json().catch(() => ({}))) as { next_run?: string };
  const now = denver();
  const due = dueTasks();
  const started: { task: string; jobId?: number; error?: string }[] = [];
  for (const t of due) {
    try { const job = await startTask(t.id, "Scheduler"); started.push({ task: t.id, jobId: job?.id }); }
    catch (e) { started.push({ task: t.id, error: e instanceof Error ? e.message : String(e) }); }
  }
  console.log(`[arnold-scheduler] ${now.stamp} due=${due.map((t) => t.id).join(",") || "none"} started=${JSON.stringify(started)} next=${next_run || "?"}`);
  return new Response(JSON.stringify({ now: now.stamp, due: due.map((t) => t.id), started }), { headers: { "content-type": "application/json" } });
};

export const config = { schedule: "0,30 * * * *" };
