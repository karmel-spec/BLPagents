/**
 * Arnold's schedule in the cloud (Brigham, 2026-10-07): the three Hermes crons
 * re-homed as tasks the Netlify scheduler (netlify/functions/arnold-scheduler.mts)
 * fires every half hour and matches against America/Denver wall-clock time, so
 * DST never shifts a run. Each due task becomes an agent_jobs row of kind
 * "task" and runs in the background function through askAgent in task mode.
 *
 *   daily-brief  7:30 Mon–Fri  read /api/reports/daily-brief → Top Ten saved to the Sales Console + summary to the team Telegram
 *   briefing     8:00 Mon–Sat  render the day's Top Ten + pipeline numbers to the team Telegram
 *   predraft     10:00 / 14:00 / 17:00 Mon–Sat  cover uncovered new/active leads with pending drafts (no Telegram post)
 *
 * After every run a line goes to Agents/arnold/STATUS.md in the vault so the
 * vault shows the cloud runtime is alive.
 */
import { allLeads, askAgent, compactLead, createJob, dispatchJob, registerTaskRunner, type Job } from "./agent-brain";
import { getFile, putFile, vaultConfigured } from "./vault-github";
import { sendMessage, teamChatId, telegramConfigured } from "./telegram";

const SALES_APP = (process.env.SALES_APP_URL || "https://blpsalesapp.netlify.app").replace(/\/$/, "");
const SALES_KEY = process.env.BLP_ARNOLD_ACCESS_KEY || "";
export const AGENT = "arnold";
export const TZ = "America/Denver";

export interface TaskDef {
  id: string;
  title: string;
  /** Denver wall-clock minutes-of-day this task fires at. */
  times: { hour: number; minute: number }[];
  /** 0 = Sunday … 6 = Saturday (Denver local). */
  days: number[];
  postToTeam: boolean;
  maxTurns: number;
  maxTokens: number;
  extraTools: string[];
  summary: string;
}
const MON_SAT = [1, 2, 3, 4, 5, 6];
const MON_FRI = [1, 2, 3, 4, 5];
export const TASKS: Record<string, TaskDef> = {
  "daily-brief": { id: "daily-brief", title: "Daily brief + Top Ten", times: [{ hour: 7, minute: 30 }], days: MON_FRI, postToTeam: true, maxTurns: 12, maxTokens: 4000, extraTools: ["save_top_ten"], summary: "7:30 Mon–Fri: last-24h facts from the Sales Console → ranked Top Ten saved to the Sales Console, summary to the BLP Sales Team Telegram." },
  briefing: { id: "briefing", title: "Morning briefing", times: [{ hour: 8, minute: 0 }], days: MON_SAT, postToTeam: true, maxTurns: 8, maxTokens: 3000, extraTools: [], summary: "8:00 Mon–Sat: the day's Top Ten (as saved at 7:30) plus pipeline numbers, posted to the BLP Sales Team Telegram." },
  predraft: { id: "predraft", title: "Pre-drafting pass", times: [{ hour: 10, minute: 0 }, { hour: 14, minute: 0 }, { hour: 17, minute: 0 }], days: MON_SAT, postToTeam: false, maxTurns: 40, maxTokens: 4000, extraTools: [], summary: "10:00 / 14:00 / 17:00 Mon–Sat: new/active leads with contact info and no pending draft get fresh sms/email drafts saved for approval (up to 8 leads per pass)." },
};

/** Denver wall-clock parts for an instant. */
export function denver(d = new Date()): { hour: number; minute: number; day: number; stamp: string; date: string } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour12: false, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value || "";
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(g("weekday"));
  const hour = Number(g("hour")) % 24;
  const minute = Number(g("minute"));
  const date = `${g("year")}-${g("month")}-${g("day")}`;
  return { hour, minute, day, date, stamp: `${date} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${isDst(d) ? "MDT" : "MST"}` };
}
const isDst = (d: Date) => /MDT|GMT-6/.test(new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "short" }).format(d));

/** Kill switch: ARNOLD_SCHEDULE_PAUSED=1 on Netlify stops the scheduler from starting tasks (manual runs still work). */
export const schedulePaused = () => /^(1|true|yes|on)$/i.test(process.env.ARNOLD_SCHEDULE_PAUSED || "");

/** Tasks due for a scheduler tick (ticks land at :00 and :30; allow a few minutes of drift). */
export function dueTasks(at = new Date()): TaskDef[] {
  if (schedulePaused()) return [];
  const { hour, minute, day } = denver(at);
  return Object.values(TASKS).filter((t) => t.days.includes(day) && t.times.some((x) => x.hour === hour && Math.abs(x.minute - minute) <= 4));
}

/** Queue one task run. Returns the job id (runs in the background on Netlify, inline locally). */
export async function startTask(taskId: string, requestedBy: string): Promise<Job | null> {
  const t = TASKS[taskId];
  if (!t) throw new Error(`Unknown Arnold task "${taskId}" (${Object.keys(TASKS).join(", ")})`);
  const id = await createJob(AGENT, requestedBy, "", `Run the scheduled task: ${t.title}`, "task", { task: taskId, requestedBy });
  return dispatchJob(id);
}

// ---------------------------------------------------------------- prompts (facts prefetched so the agent doesn't burn turns on them)
const s = (v: unknown) => (v == null ? "" : String(v));
const salesGet = async (path: string) => {
  if (!SALES_KEY) throw new Error("BLP_ARNOLD_ACCESS_KEY not set");
  const r = await fetch(`${SALES_APP}${path}`, { headers: { "x-blp-key": SALES_KEY }, signal: AbortSignal.timeout(50000), cache: "no-store" });
  if (!r.ok) throw new Error(`Sales Console ${path} → ${r.status}`);
  return r.json();
};
type Lead = Record<string, unknown> & { timeline?: { at: string; kind: string }[]; drafts?: { status: string; channel: string }[] };
const lastDirection = (l: Lead) => { for (const e of [...(l.timeline || [])].reverse()) { if (e.kind === "inbound") return "inbound"; if (["sms_out", "email_out", "call"].includes(e.kind)) return "outbound"; } return "none"; };
const pending = (l: Lead) => (l.drafts || []).filter((d) => d.status === "pending").map((d) => d.channel);

export const TASK_MODE_NOTE = `TASK MODE. This is one of your scheduled jobs, run by the cloud runtime (Netlify) — not Hermes, not a Mac. Work through it with your tools, then write your report as the final message. Hard rules: drafts are the only customer-facing writes and they wait for a rep's approval in the Sales Console; never claim anything was sent; never guess at a lead fact you can look up; the ghostwriter rule applies (drafts speak as Brigham, never mention Arnold). End your report with one final line exactly like:\nSTATUS: <one plain sentence, under 160 characters, summarizing what you did>`;

async function predraftPrompt(): Promise<string> {
  const leads = (await allLeads()) as Lead[];
  const eligible = leads.filter((l) => ["new", "active"].includes(s(l.statusBucket)) && (s(l.phoneDialable) || s(l.emailClean)));
  const uncovered = eligible.filter((l) => !pending(l).length);
  const ranked = uncovered.map((l) => ({ ...compactLead(l), ourTurn: lastDirection(l) === "inbound", hasPhone: Boolean(s(l.phoneDialable)), hasEmail: Boolean(s(l.emailClean)), followup: [...(l.timeline || [])].reverse().find((e) => e.kind === "followup") }))
    .sort((a, b) => Number(b.ourTurn) - Number(a.ourTurn) || (Number(b.score) || 0) - (Number(a.score) || 0) || Date.parse(s(b.lastContact)) - Date.parse(s(a.lastContact)) || 0);
  const batch = ranked.slice(0, 8).map((x) => ({ ...x, followup: x.followup ? `${(x.followup as { at: string; text?: string }).at}: ${s((x.followup as { text?: string }).text).slice(0, 240)}` : undefined }));
  return `Pre-drafting pass. Pipeline right now: ${leads.length} leads, ${eligible.length} eligible (new/active with usable contact info), ${uncovered.length} of them have NO pending draft.

Cover these ${batch.length} uncovered leads this pass (ranked: customer waiting on us first, then heat, then recency). For each: lookup_lead for the full history, then save_drafts with a draft for EVERY channel the lead has (sms when hasPhone, email when hasEmail) that fits your rules — obey the newest followup instruction if there is one, respond to what the customer last said, Brigham's voice, Calendly only when a call is the natural next step. Skip a lead only when drafting would be wrong (e.g. a clear decline) and say why. Do not touch leads outside this list.

${JSON.stringify(batch, null, 1)}

Report: a short list — lead, channels saved (or skipped + why) — then the coverage numbers (uncovered before/after this pass).`;
}

async function dailyBriefPrompt(): Promise<string> {
  const brief = (await salesGet("/api/reports/daily-brief?hours=24")) as Record<string, unknown>;
  let text = JSON.stringify(brief, null, 1);
  if (text.length > 90000) text = JSON.stringify({ ...brief, outboundActivity: (brief.outboundActivity as unknown[])?.slice(0, 60), topCandidates: (brief.topCandidates as unknown[])?.slice(0, 25) }, null, 1).slice(0, 90000);
  return `Daily brief (Mon–Fri 7:30). Below is the deterministic last-24-hours report from the Sales Console (/api/reports/daily-brief). Everything factual is in it — do not look leads up unless a detail you need is missing.

1. Write the brief for the sales team (Telegram, plain text): a 2–3 line pipeline headline (responses, new leads, status changes), then **Top Ten — leads a human should reach TODAY**, ranked per your 2026-09-10 coaching: customer waiting on us, recency, revenue potential, engagement; skip stale polite declines. For each: name · why today · their last action · the concrete next move (call / text / confirm time). Then "New leads" and "Customer replies" as short lists (name, one line each). Then one line on Arnold-owned coverage (openLeads / withPendingDraft / totalPendingDrafts).
2. Call save_top_ten ONCE with exactly that ranked list (rank, leadId, leadName, reason = why today + next move). This is the list the 8:00 briefing renders and Brigham's screen boosts.
3. Finish with the STATUS line.

${text}`;
}

async function briefingPrompt(): Promise<string> {
  const top = (await salesGet("/api/top-ten?scope=brigham")) as { savedAt: string | null; savedBy?: string; items: Record<string, unknown>[] };
  const leads = (await allLeads()) as Lead[];
  const open = leads.filter((l) => ["new", "active"].includes(s(l.statusBucket)));
  const counts = {
    openLeads: open.length, newLeads: open.filter((l) => s(l.statusBucket) === "new").length, active: open.filter((l) => s(l.statusBucket) === "active").length,
    customerWaitingOnUs: open.filter((l) => lastDirection(l) === "inbound").length,
    withPendingDraft: open.filter((l) => pending(l).length).length,
    eligibleUncovered: open.filter((l) => (s(l.phoneDialable) || s(l.emailClean)) && !pending(l).length).length,
    quietOver7Days: open.filter((l) => Number(l.daysSinceContact) > 7).length,
    byRep: Object.fromEntries(Array.from(new Set(open.map((l) => s(l.effectiveRep) || "unassigned"))).map((r) => [r, open.filter((l) => (s(l.effectiveRep) || "unassigned") === r).length])),
  };
  const items = (top.items || []).map((x) => ({ rank: x.rank, lead: x.leadName, leadId: x.leadId, rep: x.rep, reason: x.reason, heat: x.heat, value: x.value, daysQuiet: x.daysQuiet, status: x.status, pendingDrafts: x.pendingDrafts, hasPhone: x.hasPhone, hasEmail: x.hasEmail, worked: x.worked }));
  return `Morning briefing (Mon–Sat 8:00) for the BLP Sales Team Telegram group. The day's Top Ten below was saved at ${top.savedAt || "— (none saved; this is the live ranking)"} by ${top.savedBy || "auto-ranking"}. RENDER IT — do not compose a competing list (coaching 2026-09-10). Pipeline numbers are computed from the live Sales Console.

Write: a one-line good-morning with the date; the Top Ten as a numbered list (name · why today · next move; flag "already worked" items briefly); then 3–4 lines of pipeline numbers (open, new, customer waiting on us, pending drafts awaiting approval, uncovered); then one closing line on what you'll do today (pre-drafting at 10, 2 and 5). Keep it under 60 lines, plain text, no tables. Finish with the STATUS line.

TOP TEN: ${JSON.stringify(items, null, 1)}

PIPELINE: ${JSON.stringify(counts, null, 1)}`;
}

// ---------------------------------------------------------------- run + vault STATUS writeback
function splitStatus(reply: string): { body: string; status: string } {
  const m = /\n?\s*STATUS:\s*(.+)\s*$/i.exec(reply);
  if (m) return { body: reply.slice(0, m.index).trim(), status: m[1].trim().slice(0, 200) };
  return { body: reply.trim(), status: reply.replace(/\s+/g, " ").trim().slice(0, 160) };
}

const STATUS_PATH = "Agents/arnold/STATUS.md";
const SECTION = "## Cloud runtime (Netlify)";
export async function writeVaultStatus(taskId: string, status: string, jobId: number, ok: boolean): Promise<string | null> {
  if (!vaultConfigured()) return null;
  const f = await getFile(STATUS_PATH);
  const { stamp } = denver();
  const line = `- ${stamp} — ${ok ? "✅" : "❌"} ${TASKS[taskId]?.title || taskId}: ${status.replace(/\n/g, " ")} _(job ${jobId})_`;
  let text = f?.content || "# Arnold — STATUS\n";
  const start = text.indexOf(SECTION);
  if (start >= 0) {
    const after = text.indexOf("\n## ", start + SECTION.length);
    const block = text.slice(start, after >= 0 ? after : undefined);
    const lines = block.split("\n").filter((l) => l.startsWith("- "));
    const kept = [line, ...lines].slice(0, 8);
    const fresh = `${SECTION}\n_Arnold's schedule runs on Netlify (blpagents.netlify.app) — latest runs, newest first. Hermes on the Mac is no longer required for these._\n${kept.join("\n")}\n`;
    text = text.slice(0, start) + fresh + (after >= 0 ? "\n" + text.slice(after + 1) : "");
  } else {
    text = `${text.trimEnd()}\n\n${SECTION}\n_Arnold's schedule runs on Netlify (blpagents.netlify.app) — latest runs, newest first. Hermes on the Mac is no longer required for these._\n${line}\n`;
  }
  text = text.replace(/^_Updated: .*$/m, `_Updated: ${stamp} by Arnold (cloud runtime)._`);
  const r = await putFile(STATUS_PATH, text, f?.sha || null, `Arnold STATUS: ${TASKS[taskId]?.title || taskId} run (cloud)`, { name: "Arnold (BLP agent, cloud)", email: "arnold@brighamlarsonpianos.com" });
  return r.commitUrl;
}

async function runTask(job: Job): Promise<NonNullable<Job["result"]>> {
  const taskId = s(job.payload?.task);
  const t = TASKS[taskId];
  if (!t) throw new Error(`Unknown task ${taskId}`);
  let reply = "";
  let tools: string[] = [];
  let status = "";
  let ok = true;
  try {
    const prompt = taskId === "predraft" ? await predraftPrompt() : taskId === "daily-brief" ? await dailyBriefPrompt() : await briefingPrompt();
    const out = await askAgent(AGENT, job.who || "Scheduler", "", prompt, job.id, { via: "schedule", systemNote: TASK_MODE_NOTE, maxTurns: t.maxTurns, maxTokens: t.maxTokens, extraTools: t.extraTools, freshContext: true, storePrompt: false, channelNote: `You are running a scheduled task in the cloud runtime (no chat window).`, meta: { task: taskId } });
    tools = out.tools;
    const sp = splitStatus(out.reply);
    reply = sp.body; status = sp.status;
  } catch (e) {
    ok = false; status = `failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 140)}`;
  }
  const result: NonNullable<Job["result"]> = { reply, tools };
  if (ok && t.postToTeam && reply) {
    if (telegramConfigured(AGENT) && teamChatId()) {
      try { result.telegramMessageIds = await sendMessage(AGENT, teamChatId(), reply); }
      catch (e) { status += ` · Telegram post failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`; }
    } else status += " · not posted to Telegram (TELEGRAM_BOT_TOKEN_ARNOLD / TELEGRAM_CHAT_ID unset)";
  }
  try { result.vaultCommit = (await writeVaultStatus(taskId, status, job.id, ok)) || undefined; }
  catch (e) { status += ` · vault STATUS not written: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`; }
  if (!ok) throw new Error(status);
  result.summary = status;
  return result;
}
registerTaskRunner(AGENT, runTask);
