/**
 * Clara's schedule in the cloud (Brigham, 2026-10-07): her Hermes cron re-homed as a
 * task the Netlify scheduler (netlify/functions/clara-scheduler.mts) fires on Denver
 * wall-clock time. Same pattern as arnold-tasks.ts.
 *
 *   daily-brief  7:00 Mon–Fri  Brigham's Daily Brief per Agents/clara/BRIEF_SOURCES.md,
 *                              facts prefetched here, judgment by Clara, posted to
 *                              Brigham's Telegram chat (TELEGRAM_CHAT_ID_CLARA) and
 *                              logged to Agents/clara/STATUS.md in the vault.
 *
 * Every fact line is a fetch in this file; when a fetch fails the prompt carries
 * "could not verify" for that line and Clara says so (her no-guessing rule).
 */
import { askAgent, createJob, dispatchJob, registerTaskRunner, type Job } from "./agent-brain";
import { denver, TZ } from "./arnold-tasks";
import { getFile, putFile, vaultConfigured } from "./vault-github";
import { googleGet, getGoogleTokenAs } from "./google-auth";
import { BRIEFS_FOLDER_ID } from "./briefings";
import { mailboxConfigured, searchMail } from "./mail";
import { sendMessage, telegramConfigured } from "./telegram";

export const AGENT = "clara";
export { TZ };
const SALES_APP = (process.env.SALES_APP_URL || "https://blpsalesapp.netlify.app").replace(/\/$/, "");
const SALES_KEY = process.env.BLP_ARNOLD_ACCESS_KEY || "";
const STOREMAP_KEY = process.env.BLP_STOREMAP_TASKBOARD_KEY || "pianoman";
/** Brigham's private chat with @clara's bot (set on Netlify); falls back to the team chat only if explicitly asked. */
export const briefChatId = (): string => process.env.TELEGRAM_CHAT_ID_CLARA || "";

export interface TaskDef { id: string; title: string; times: { hour: number; minute: number }[]; days: number[]; maxTurns: number; maxTokens: number; extraTools: string[]; summary: string }
const MON_FRI = [1, 2, 3, 4, 5];
export const TASKS: Record<string, TaskDef> = {
  "daily-brief": { id: "daily-brief", title: "Brigham's Daily Brief", times: [{ hour: 7, minute: 0 }], days: MON_FRI, maxTurns: 10, maxTokens: 4000, extraTools: [], summary: "7:00 Mon–Fri: calendar · task cards waiting on Brigham · Arnold's Top Ten · pianos needing track/scope + before video · attic count · inbox approval table · Thursday training line · top 3 only he can move. Posted to Brigham's Telegram." },
};

export const schedulePaused = () => /^(1|true|yes|on)$/i.test(process.env.CLARA_SCHEDULE_PAUSED || "");
export function dueTasks(at = new Date()): TaskDef[] {
  if (schedulePaused()) return [];
  const { hour, minute, day } = denver(at);
  return Object.values(TASKS).filter((t) => t.days.includes(day) && t.times.some((x) => x.hour === hour && Math.abs(x.minute - minute) <= 4));
}
export async function startTask(taskId: string, requestedBy: string): Promise<Job | null> {
  const t = TASKS[taskId];
  if (!t) throw new Error(`Unknown Clara task "${taskId}" (${Object.keys(TASKS).join(", ")})`);
  const id = await createJob(AGENT, requestedBy, "", `Run the scheduled task: ${t.title}`, "task", { task: taskId, requestedBy });
  return dispatchJob(id);
}

// ---------------------------------------------------------------- fact fetchers (each returns text, never throws)
const s = (v: unknown) => (v == null ? "" : String(v));
const CNV = "could not verify";
async function safe(label: string, fn: () => Promise<string>): Promise<string> {
  try { return await fn(); } catch (e) { return `${CNV} — ${label}: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`; }
}

async function calendarToday(): Promise<string> {
  const user = "brigham@brighamlarsonpianos.com";
  const tok = await getGoogleTokenAs(user, ["https://www.googleapis.com/auth/calendar.readonly"]);
  const { date } = denver();
  const start = new Date(`${date}T00:00:00-06:00`); const end = new Date(start.getTime() + 864e5);
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&timeMin=${start.toISOString()}&timeMax=${end.toISOString()}&maxResults=25`, { headers: { Authorization: `Bearer ${tok}` }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`Calendar ${r.status}`);
  const j = (await r.json()) as { items?: { summary?: string; start?: { dateTime?: string; date?: string }; attendees?: { email: string }[]; location?: string; description?: string }[] };
  const items = (j.items || []).map((e) => { const t = e.start?.dateTime ? new Date(e.start.dateTime).toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" }) : "all day"; return `${t} · ${e.summary || "(untitled)"}${e.location ? ` · ${e.location}` : ""}${e.attendees?.length ? ` · with ${e.attendees.filter((a) => a.email !== user).map((a) => a.email).slice(0, 4).join(", ")}` : ""}${e.description ? ` · ${s(e.description).replace(/\s+/g, " ").slice(0, 120)}` : ""}`; });
  return items.length ? items.join("\n") : "No events today.";
}

async function taskBoard(): Promise<string> {
  const r = await fetch(`${SALES_APP}/.netlify/functions/storemap-taskboard?key=${encodeURIComponent(STOREMAP_KEY)}`, { signal: AbortSignal.timeout(25000), cache: "no-store" });
  if (!r.ok) throw new Error(`task board ${r.status}`);
  const j = (await r.json()) as { rows?: { owner: string; col: string; text: string; serial?: string; due?: string; done?: string; created?: string }[]; cols?: Record<string, [string, string][]> };
  const rows = j.rows || []; const cols = j.cols || {};
  const label = (owner: string, col: string) => (cols[owner] || []).find((c) => c[0] === col)?.[1] || col;
  const own = rows.filter((x) => /brigham/i.test(x.owner) && !x.done && !/archived/i.test(x.col)).sort((a, b) => s(a.created).localeCompare(s(b.created)));
  const asks = rows.filter((x) => !/brigham/i.test(x.owner) && !x.done && /ask brigham|management requests|brigham/i.test(label(x.owner, x.col)));
  const fmt = (x: typeof rows[number]) => `- ${x.text}${x.serial ? ` (${x.serial})` : ""}${x.due ? ` · due ${x.due}` : ""}${x.created ? ` · since ${s(x.created).slice(0, 10)}` : ""}`;
  return `His own board: ${own.length} open cards. With a due date or oldest:\n${[...own.filter((x) => x.due), ...own.filter((x) => !x.due)].slice(0, 6).map(fmt).join("\n") || "- none"}\n\nQuestions for him on other boards: ${asks.length}\n${asks.slice(0, 8).map((x) => `- [${x.owner} / ${label(x.owner, x.col)}] ${x.text}`).join("\n") || "- none"}\nLink: https://blpstoremap.netlify.app (🗒 task board)`;
}

async function topTen(): Promise<string> {
  if (!SALES_KEY) throw new Error("BLP_ARNOLD_ACCESS_KEY not set");
  const r = await fetch(`${SALES_APP}/api/top-ten?scope=brigham`, { headers: { "x-blp-key": SALES_KEY }, signal: AbortSignal.timeout(20000), cache: "no-store" });
  if (!r.ok) throw new Error(`top ten ${r.status}`);
  const j = (await r.json()) as { savedAt: string | null; items: { rank: number; leadName: string; reason: string }[] };
  const fresh = j.savedAt && Date.now() - Date.parse(j.savedAt) < 20 * 36e5;
  return `${fresh ? `Arnold's Top Ten (saved ${j.savedAt}) — link: https://blpsalesapp.netlify.app` : `Arnold's brief isn't posted yet for today (last Top Ten saved ${j.savedAt || "never"}) — remind Brigham it lands at 7:30 and link https://blpsalesapp.netlify.app`}\n${(j.items || []).slice(0, 10).map((x) => `${x.rank}. ${x.leadName} — ${x.reason}`).join("\n")}`;
}

/** Shop Manager Briefing (written 7:44 daily) — pull the four sections Clara reports on. */
async function shopBriefing(): Promise<string> {
  const since = new Date(Date.now() - 2 * 864e5).toISOString();
  const q = `'${BRIEFS_FOLDER_ID}' in parents and trashed=false and name contains 'Shop Manager Briefing' and modifiedTime > '${since}'`;
  const list = await googleGet(`https://www.googleapis.com/drive/v3/files?${new URLSearchParams({ q, orderBy: "modifiedTime desc", pageSize: "1", fields: "files(id,name,modifiedTime)", supportsAllDrives: "true", includeItemsFromAllDrives: "true" })}`, ["https://www.googleapis.com/auth/drive.readonly"]);
  const f = (list.files || [])[0] as { id: string; name: string; modifiedTime: string } | undefined;
  if (!f) return "No Shop Manager Briefing in the last 2 days — report 'not posted yet' (it is written at 7:44).";
  const doc = await googleGet(`https://docs.googleapis.com/v1/documents/${f.id}?fields=body.content(paragraph(elements(textRun(content))))`, ["https://www.googleapis.com/auth/documents.readonly"]);
  const text = ((doc.body?.content || []) as { paragraph?: { elements?: { textRun?: { content?: string } }[] } }[]).map((el) => (el.paragraph?.elements || []).map((e) => e.textRun?.content || "").join("")).join("");
  const section = (title: RegExp) => { const m = text.match(new RegExp(`(${title.source})[\\s\\S]{0,1200}?(?=\\n\\s*(?:[🆕📷🚚🧹📋🔧✅⚠️🎹#]|$))`, "u")); return m ? m[0].trim().slice(0, 900) : null; };
  const parts = [["🆕 Temp pianos awaiting approval", section(/🆕[^\n]*/)], ["📷 Media (before photos/video needed)", section(/📷[^\n]*/)], ["🚚 Arrivals with no Piano Log row", section(/🚚[^\n]*/)], ["🧹 Housekeeping / attic (not on a numbered spot)", section(/🧹[^\n]*/)]];
  const isToday = new Intl.DateTimeFormat("en-US", { timeZone: TZ, dateStyle: "short" }).format(new Date(f.modifiedTime)) === new Intl.DateTimeFormat("en-US", { timeZone: TZ, dateStyle: "short" }).format(new Date());
  return `${f.name}${isToday ? "" : " (YESTERDAY's — today's is written at 7:44; say so)"}\n` + parts.map(([t, v]) => `${t}: ${v || "section absent → none today"}`).join("\n\n") + `\nLinks: Missing Shop Stage https://blpstoremap.netlify.app/#report=stage · Media Needed https://blpstoremap.netlify.app/#report=media · Attic https://blpstoremap.netlify.app/#report=unplaced`;
}

async function inboxTable(): Promise<string> {
  const personal = "brighamlarson@gmail.com"; const work = "brigham@brighamlarsonpianos.com";
  const mb = mailboxConfigured(personal).ok ? personal : work;
  const hits = await searchMail(mb, "is:unread newer_than:1d", 40);
  const seen = new Map<string, { from: string; subject: string; n: number; id: string }>();
  for (const h of hits) { const key = `${h.fromAddress}|${h.subject.replace(/^(re|fwd?):\s*/i, "").replace(/\s*\d+\s*$/, "").toLowerCase()}`; const e = seen.get(key); if (e) e.n++; else seen.set(key, { from: h.from, subject: h.subject, n: 1, id: h.id }); }
  const rows = Array.from(seen.values()).map((x) => `- [${x.id}] ${x.from} · ${x.subject}${x.n > 1 ? ` (×${x.n})` : ""}`);
  return `Mailbox used: ${mb}${mb === work ? " (personal Gmail not connected in the cloud yet — BRIGHAM_GMAIL_APP_PASSWORD)" : ""}. ${hits.length} unread in the last day, ${rows.length} after collapsing duplicates:\n${rows.join("\n") || "- none"}`;
}

async function trainingLine(): Promise<string> {
  const f = await getFile("Agents/clara/TRAINING_PLAN.md");
  const m = f?.content.match(/\*\*Next up:\s*([^*]+)\*\*/);
  return m ? m[1].trim() : "Next section not found in TRAINING_PLAN.md";
}

async function dailyBriefPrompt(): Promise<string> {
  const { day, stamp } = denver();
  const [cal, board, top, shop, inbox, training] = await Promise.all([
    safe("calendar (needs calendar.readonly delegated to the service account)", calendarToday),
    safe("Store Map task board", taskBoard),
    safe("Arnold's Top Ten", topTen),
    safe("Shop Manager Briefing", shopBriefing),
    safe("inbox", inboxTable),
    safe("training plan", trainingLine),
  ]);
  return `Brigham's Daily Brief — ${stamp}. Every fact you need is below, fetched by the runtime per BRIEF_SOURCES.md; do not re-fetch. Where a line says "${CNV}", write exactly "could not verify" for that section and move on.

Write the brief for Brigham (Telegram, plain text, short, sign "— Clara") in this order:
1. Today's calendar — time · title · one line of prep.
2. Task cards waiting on him — counts, then the dated/oldest ones.
3. Sales — link the Top Ten and remind him: touch base with your ten hottest leads today.
4. New pianos waiting on him — temp pianos to approve, "N videos are waiting on you", arrivals with no Piano Log row.
5. Attic — N pianos not on a numbered spot.
6. Inbox approval table — From · Subject · Proposed action (Archive / Unsubscribe / Delegate to admin: who / Needs Brigham). Proposals only; nothing has been changed.
${day === 4 ? "7. Thursday 8:00 AM training — the next handbook section (below).\n" : ""}8. Top 3 things only Brigham can move today.
Finish with one line: STATUS: <what you posted, counts, anything you could not verify>.

### 1 CALENDAR
${cal}

### 2 TASK BOARD
${board}

### 3 SALES
${top}

### 4+5 SHOP MANAGER BRIEFING
${shop}

### 6 INBOX
${inbox}

### 7 TRAINING (Thursdays)
${training}`;
}

// ---------------------------------------------------------------- run + vault STATUS writeback
export const TASK_MODE_NOTE = `TASK MODE. This is your scheduled job, run by the cloud runtime (Netlify) — not Hermes, not a Mac. No human is typing. Use the facts given; do not look things up unless a detail is missing, and never guess. Your final message is the brief itself, ending with a STATUS: line.`;

function splitStatus(reply: string): { body: string; status: string } {
  const m = /\n?\s*STATUS:\s*(.+)\s*$/i.exec(reply);
  if (m) return { body: reply.slice(0, m.index).trim(), status: m[1].trim().slice(0, 200) };
  return { body: reply.trim(), status: reply.replace(/\s+/g, " ").trim().slice(0, 160) };
}
const STATUS_PATH = "Agents/clara/STATUS.md";
const SECTION = "## Cloud runtime (Netlify)";
export async function writeVaultStatus(taskId: string, status: string, jobId: number, ok: boolean): Promise<string | null> {
  if (!vaultConfigured()) return null;
  const f = await getFile(STATUS_PATH);
  const { stamp } = denver();
  const line = `- ${stamp} — ${ok ? "✅" : "❌"} ${TASKS[taskId]?.title || taskId}: ${status.replace(/\n/g, " ")} _(job ${jobId})_`;
  const note = "_Clara's schedule runs on Netlify (blpagents.netlify.app) — latest runs, newest first. Hermes on the Mac is no longer required for these._";
  let text = f?.content || "# Clara — STATUS\n";
  const start = text.indexOf(SECTION);
  if (start >= 0) {
    const after = text.indexOf("\n## ", start + SECTION.length);
    const block = text.slice(start, after >= 0 ? after : undefined);
    const kept = [line, ...block.split("\n").filter((l) => l.startsWith("- "))].slice(0, 8);
    text = text.slice(0, start) + `${SECTION}\n${note}\n${kept.join("\n")}\n` + (after >= 0 ? "\n" + text.slice(after + 1) : "");
  } else text = `${text.trimEnd()}\n\n${SECTION}\n${note}\n${line}\n`;
  text = text.replace(/^_Updated: .*$/m, `_Updated: ${stamp} by Clara (cloud runtime)._`);
  const r = await putFile(STATUS_PATH, text, f?.sha || null, `Clara STATUS: ${TASKS[taskId]?.title || taskId} run (cloud)`, { name: "Clara (BLP agent, cloud)", email: "clara@brighamlarsonpianos.com" });
  return r.commitUrl;
}

async function runTask(job: Job): Promise<NonNullable<Job["result"]>> {
  const taskId = s(job.payload?.task);
  const t = TASKS[taskId];
  if (!t) throw new Error(`Unknown task ${taskId}`);
  let reply = ""; let tools: string[] = []; let status = ""; let ok = true;
  try {
    const prompt = await dailyBriefPrompt();
    const out = await askAgent(AGENT, job.who || "Scheduler", "", prompt, job.id, { via: "schedule", systemNote: TASK_MODE_NOTE, maxTurns: t.maxTurns, maxTokens: t.maxTokens, extraTools: t.extraTools, freshContext: true, storePrompt: false, meta: { task: taskId } });
    tools = out.tools;
    const sp = splitStatus(out.reply); reply = sp.body; status = sp.status;
  } catch (e) { ok = false; status = `failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 140)}`; }
  const result: NonNullable<Job["result"]> = { reply, tools };
  if (ok && reply) {
    if (telegramConfigured(AGENT) && briefChatId()) {
      try { result.telegramMessageIds = await sendMessage(AGENT, briefChatId(), reply); }
      catch (e) { status += ` · Telegram post failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`; }
    } else status += " · not posted to Telegram (TELEGRAM_BOT_TOKEN_CLARA / TELEGRAM_CHAT_ID_CLARA unset) — brief is in the console thread";
  }
  try { result.vaultCommit = (await writeVaultStatus(taskId, status, job.id, ok)) || undefined; }
  catch (e) { status += ` · vault STATUS not written: ${(e instanceof Error ? e.message : String(e)).slice(0, 80)}`; }
  if (!ok) throw new Error(status);
  result.summary = status;
  return result;
}
registerTaskRunner(AGENT, runTask);
