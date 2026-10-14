/**
 * SCHEDULED function: fires at :00 and :30 UTC, converts to America/Denver and
 * starts every team-set routine (Supabase agent_routines, set in the Agent
 * Console) that is due at that wall-clock time. Each run is a normal job:
 * engine "grokbot" wakes the agent's Grok Bot, "claude" runs the in-app mind.
 * Kill switch: ROUTINES_PAUSED=1.
 */
import { dueRoutines, startRoutine } from "../../src/lib/routines";
import { denver } from "../../src/lib/arnold-tasks";

export default async (req: Request) => {
  const { next_run } = (await req.json().catch(() => ({}))) as { next_run?: string };
  const now = denver();
  const started: { routine: number; agent: string; jobId?: number; error?: string }[] = [];
  let due: Awaited<ReturnType<typeof dueRoutines>> = [];
  try { due = await dueRoutines(); } catch (e) { console.log(`[routines-scheduler] could not read routines: ${e instanceof Error ? e.message : String(e)}`); }
  for (const r of due) {
    try { const job = await startRoutine(r, "Scheduler"); started.push({ routine: r.id, agent: r.agent, jobId: job?.id }); }
    catch (e) { started.push({ routine: r.id, agent: r.agent, error: e instanceof Error ? e.message : String(e) }); }
  }
  console.log(`[routines-scheduler] ${now.stamp} due=${due.map((r) => `${r.agent}#${r.id}`).join(",") || "none"} started=${JSON.stringify(started)} next=${next_run || "?"}`);
  return new Response(JSON.stringify({ now: now.stamp, started }), { headers: { "content-type": "application/json" } });
};

export const config = { schedule: "0,30 * * * *" };
