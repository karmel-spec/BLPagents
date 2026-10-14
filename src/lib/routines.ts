/**
 * Team-set routines for the Grok Bot agents (Brigham, 2026-10-14): "I want the
 * BLP human team to be able to chat and set routines with these grokbot agents
 * from the BLP agent console." Grok Bot has no API for its own routines, so the
 * console owns them: a row in Supabase `agent_routines` (title, prompt, Denver
 * time, days, where to deliver), a scheduled Netlify function that starts the
 * due ones, and the normal job path — engine "grokbot" wakes the agent's Bot
 * with the prompt, engine "claude" runs the in-app mind. The reply lands in the
 * agent's shared thread and, if asked, in a Telegram chat or the team group.
 * The code-defined schedules (arnold-tasks.ts, clara-tasks.ts) keep running
 * beside these; they prefetch facts that a free-text routine cannot.
 */
import { createJob, dispatchJob, getJob, type Job } from "./agent-brain";
import { supa } from "./supa";
import { denver } from "./arnold-tasks";

export interface Routine {
  id: number;
  agent: string;
  title: string;
  prompt: string;
  hour: number;
  minute: number;
  days: number[]; // 0 = Sunday … 6 = Saturday (Denver time)
  deliver: { telegramChatId?: string; teamGroup?: boolean };
  enabled: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  last_run_key: string | null;
  last_run_at: string | null;
  last_job_id: number | null;
  last_status: string | null;
  last_summary: string | null;
}

export const ROUTINE_NOTE = `ROUTINE MODE. This is a routine a BLP teammate set for you in the Agent Console, run by the cloud scheduler — no human is typing. Do what the routine asks with your tools; never guess a fact you can look up; never send anything to a customer (drafts wait for approval). Your final message is the routine's output, written for the people it is delivered to. End with one line exactly like:\nSTATUS: <one plain sentence, under 160 characters>`;

export const routinesPaused = () => /^(1|true|yes|on)$/i.test(process.env.ROUTINES_PAUSED || "");

const clean = (r: Partial<Routine>) => {
  const days = Array.from(new Set((Array.isArray(r.days) ? r.days : []).map(Number).filter((d) => d >= 0 && d <= 6))).sort();
  const out: Partial<Routine> = {};
  if (r.title !== undefined) out.title = String(r.title).trim().slice(0, 120);
  if (r.prompt !== undefined) out.prompt = String(r.prompt).trim().slice(0, 12000);
  if (r.hour !== undefined) out.hour = Math.min(23, Math.max(0, Number(r.hour) || 0));
  if (r.minute !== undefined) out.minute = Math.min(59, Math.max(0, Number(r.minute) || 0));
  if (r.days !== undefined) out.days = days;
  if (r.deliver !== undefined) out.deliver = { ...(r.deliver?.telegramChatId ? { telegramChatId: String(r.deliver.telegramChatId).trim().slice(0, 40) } : {}), ...(r.deliver?.teamGroup ? { teamGroup: true } : {}) };
  if (r.enabled !== undefined) out.enabled = Boolean(r.enabled);
  return out;
};

export async function listRoutines(agent: string): Promise<Routine[]> {
  return supa<Routine[]>(`agent_routines?agent=eq.${encodeURIComponent(agent)}&order=hour.asc,minute.asc,id.asc`);
}
export async function getRoutine(id: number): Promise<Routine | null> {
  const r = await supa<Routine[]>(`agent_routines?id=eq.${id}&limit=1`);
  return r[0] || null;
}
export async function createRoutine(agent: string, input: Partial<Routine>, createdBy: string): Promise<Routine> {
  const c = clean(input);
  if (!c.title) throw new Error("Give the routine a title");
  if (!c.prompt) throw new Error("Write what the routine should do");
  if (!c.days?.length) throw new Error("Pick at least one day");
  const r = await supa<Routine[]>("agent_routines", { method: "POST", body: JSON.stringify({ agent, title: c.title, prompt: c.prompt, hour: c.hour ?? 8, minute: c.minute ?? 0, days: c.days, deliver: c.deliver || {}, enabled: c.enabled ?? true, created_by: createdBy }) });
  return r[0];
}
export async function updateRoutine(id: number, agent: string, input: Partial<Routine>): Promise<Routine | null> {
  const c = clean(input);
  if (c.days && !c.days.length) throw new Error("Pick at least one day");
  const r = await supa<Routine[]>(`agent_routines?id=eq.${id}&agent=eq.${encodeURIComponent(agent)}`, { method: "PATCH", body: JSON.stringify({ ...c, updated_at: new Date().toISOString() }) });
  return r[0] || null;
}
export async function deleteRoutine(id: number, agent: string): Promise<boolean> {
  const r = await supa<Routine[]>(`agent_routines?id=eq.${id}&agent=eq.${encodeURIComponent(agent)}`, { method: "DELETE" });
  return r.length > 0;
}

const runKey = (r: Routine, d = denver()) => `${d.date} ${String(r.hour).padStart(2, "0")}:${String(r.minute).padStart(2, "0")}`;

/** Routines due for a scheduler tick (ticks at :00/:30; a few minutes of drift allowed; each slot runs once). */
export async function dueRoutines(at = new Date()): Promise<Routine[]> {
  if (routinesPaused()) return [];
  const d = denver(at);
  const rows = await supa<Routine[]>(`agent_routines?enabled=eq.true&hour=eq.${d.hour}`);
  return rows.filter((r) => r.days.includes(d.day) && Math.abs(r.minute - d.minute) <= 4 && r.last_run_key !== runKey(r, d));
}

/** Start one routine now (scheduler or "Run now"). */
export async function startRoutine(r: Routine, requestedBy: string): Promise<Job | null> {
  const key = runKey(r);
  const jobId = await createJob(r.agent, requestedBy, "", r.prompt, "routine", { routine: { id: r.id, title: r.title, deliver: r.deliver || {} }, systemNote: ROUTINE_NOTE, channelNote: `You are running the routine "${r.title}" in the cloud runtime (no chat window).`, requestedBy });
  await supa(`agent_routines?id=eq.${r.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_run_key: key, last_run_at: new Date().toISOString(), last_job_id: jobId, last_status: "running", last_summary: null }) });
  return dispatchJob(jobId);
}

function splitStatus(reply: string): { body: string; status: string } {
  const m = /\n?STATUS:\s*(.+)\s*$/i.exec(reply);
  return m ? { body: reply.slice(0, m.index).trim(), status: m[1].trim().slice(0, 240) } : { body: reply.trim(), status: "" };
}

/** Deliver a finished routine run (either engine): thread row, Telegram, routine bookkeeping. */
export async function finishRoutine(job: Job, reply: string, ok: boolean, error?: string): Promise<NonNullable<Job["result"]>> {
  const rt = job.payload?.routine;
  const sp = splitStatus(reply || "");
  let status = ok ? (sp.status || "done") : `failed: ${(error || "").slice(0, 160)}`;
  const result: NonNullable<Job["result"]> = { reply: sp.body, tools: [] };
  if (ok && sp.body) {
    const name = job.agent.charAt(0).toUpperCase() + job.agent.slice(1);
    try { await supa("agent_messages", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ agent: job.agent, role: "agent", who: name, who_email: "", body: `🕗 ${rt?.title || "Routine"}\n\n${sp.body}`, run_id: `routine-job:${job.id}`, meta: { via: "schedule", routine: rt?.id, engine: job.payload?.engine || "claude" } }) }); }
    catch (e) { status += ` · thread row not stored: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`; }
    const d = rt?.deliver || {};
    if (d.telegramChatId || d.teamGroup) {
      try {
        const { sendMessage, teamChatId, telegramConfigured } = await import("./telegram");
        if (!telegramConfigured(job.agent)) status += ` · not sent to Telegram (TELEGRAM_BOT_TOKEN_${job.agent.toUpperCase()} unset)`;
        else {
          const targets = [d.telegramChatId, d.teamGroup ? teamChatId() : ""].filter(Boolean) as string[];
          const ids: number[] = [];
          for (const t of targets) ids.push(...(await sendMessage(job.agent, t, `${rt?.title ? `${rt.title}\n\n` : ""}${sp.body}`)));
          result.telegramMessageIds = ids;
        }
      } catch (e) { status += ` · Telegram failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`; }
    }
  }
  result.summary = status;
  if (rt?.id) {
    try { await supa(`agent_routines?id=eq.${rt.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ last_status: ok ? "done" : "failed", last_summary: status.slice(0, 400), last_run_at: new Date().toISOString() }) }); } catch { /* bookkeeping only */ }
  }
  if (!ok) throw new Error(status);
  return result;
}

export async function recentRoutineRuns(agent: string, limit = 12): Promise<Job[]> {
  return supa<Job[]>(`agent_jobs?agent=eq.${encodeURIComponent(agent)}&kind=eq.routine&order=id.desc&limit=${limit}`);
}
export { getJob };
