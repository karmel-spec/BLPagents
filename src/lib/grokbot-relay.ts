/**
 * Grok Bot relay (Brigham, 2026-10-08): the console is every agent's inbox.
 * (Fleet-wide layer. Ivory, Chris and Eddy keep their earlier per-agent bridges —
 * grokbot.ts and grokbot-bridge.ts — and are never routed through this file.)
 *
 *   1. a message or scheduled task becomes an agent_jobs row (as before)
 *   2. runJob sees engine "grokbot" and POSTs the Bot routine's webhook with the job (the wake)
 *   3. the Bot works through the console's MCP server, /api/mcp/<slug>:
 *      load_mind, read_vault_file, search_leads, search_shop_pianos, mail tools…
 *   4. the Bot calls reply_to_team (MCP) — or POST /api/agents/<slug>/reply —
 *   5. completeGrokJob stores the reply in agent_messages (the one thread every
 *      app reads), closes the job, and delivers it: Telegram reply, team post,
 *      vault STATUS line for scheduled tasks. Surfaces polling the job get it.
 * A Bot that never answers: the job is marked failed after GROKBOT_WAIT_MINUTES
 * (nothing is ever answered on the agent's behalf — Brigham's rule).
 */
import { ENGINE_LABEL, engineFor, grokbotWaitMs, grokbotWebhookKey, grokbotWebhookUrl } from "./engine";
import { supa } from "./supa";
import { config } from "./config";
import { channelNoteFor, getJob, loadTaskHooks, type Job, type JobPayload } from "./agent-brain";
import { getAgent } from "./agents";

const base = () => config.publicBaseUrl.replace(/\/$/, "");
const name = (slug: string) => getAgent(slug)?.name || slug.charAt(0).toUpperCase() + slug.slice(1);

/** What the Bot receives when woken. Everything it needs to answer without another round trip, plus where to read more and how to reply. */
export async function wakePayload(job: Job, extra: { message?: string; systemNote?: string; channelNote?: string } = {}) {
  const p = job.payload || {};
  const mcpUrl = `${base()}/api/mcp/${job.agent}`;
  return {
    event: "blp.job",
    jobId: job.id,
    agent: job.agent,
    agentName: name(job.agent),
    kind: job.kind,
    via: job.kind === "telegram" ? "telegram" : job.kind === "task" ? "schedule" : p.event ? "event" : "console",
    who: job.who,
    whoEmail: job.who_email,
    message: extra.message ?? String(p.message || ""),
    channelNote: extra.channelNote ?? channelNoteFor(job),
    systemNote: extra.systemNote ?? p.systemNote ?? "",
    task: p.task || null,
    telegram: p.telegram ? { chatId: p.telegram.chatId, chatType: p.telegram.chatType, chatTitle: p.telegram.chatTitle } : null,
    deadline: new Date(Date.now() + grokbotWaitMs()).toISOString(),
    howToReply: {
      mcp: { url: mcpUrl, tool: "reply_to_team", args: { jobId: job.id, reply: "<your answer>" } },
      rest: { method: "POST", url: `${base()}/api/agents/${job.agent}/reply`, body: { jobId: job.id, reply: "<your answer>" }, auth: "Authorization: Bearer <your GROKBOT_CALLBACK_KEY>" },
    },
    howToThink: `Call load_mind first (your SOUL, rules and memory from the BLP Knowledge Vault), then thread_history if the message needs context, then the lookup tools (never guess a fact you can look up). Finish by calling reply_to_team once with jobId ${job.id}.`,
  };
}

/** POST the job to the Bot's routine webhook. Marks the job as woken; throws when the wake itself fails. */
export async function wakeGrokBot(job: Job, extra: { message?: string; systemNote?: string; channelNote?: string } = {}): Promise<void> {
  const url = grokbotWebhookUrl(job.agent);
  if (!url) throw new Error(`GROKBOT_WEBHOOK_URL_${job.agent.toUpperCase()} is not set on the console`);
  const body = await wakePayload(job, extra);
  const key = grokbotWebhookKey(job.agent);
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text().catch(() => "");
  if (!r.ok) throw new Error(`Grok Bot webhook for ${name(job.agent)} answered ${r.status}: ${text.slice(0, 200)}`);
  const payload: JobPayload = { ...(job.payload || {}), engine: "grokbot", wokeAt: new Date().toISOString(), deadline: body.deadline, systemNote: body.systemNote || undefined, wakeMessage: extra.message && extra.message !== job.payload?.message ? extra.message : undefined };
  await supa(`agent_jobs?id=eq.${job.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ payload }) });
}

/** A woken job past its deadline is failed — the Bot did not answer. Returns the (possibly updated) job. */
export async function expireIfStale(job: Job | null): Promise<Job | null> {
  if (!job || job.status !== "running" || job.payload?.engine !== "grokbot") return job;
  const deadline = Date.parse(String(job.payload?.deadline || "")) || (Date.parse(job.started_at || job.created_at) + grokbotWaitMs());
  if (Date.now() < deadline) return job;
  const msg = `${name(job.agent)}'s Grok Bot did not answer within ${Math.round(grokbotWaitMs() / 60000)} minutes. Nothing was answered on their behalf — check the Bot in the Grok app (routine webhook, MCP connection) and send the message again.`;
  const rows = await supa<Job[]>(`agent_jobs?id=eq.${job.id}&status=eq.running`, { method: "PATCH", body: JSON.stringify({ status: "failed", error: msg, finished_at: new Date().toISOString() }) });
  if (rows[0] && job.kind === "telegram" && job.payload?.telegram) {
    try { const { sendMessage } = await import("./telegram"); await sendMessage(job.agent, job.payload.telegram.chatId, `Sorry — ${msg}`); } catch { /* best effort */ }
  }
  return rows[0] || getJob(job.id);
}

/** Jobs an agent's Bot still owes an answer for (running, woken, not expired). */
export async function openGrokJobs(slug: string): Promise<Job[]> {
  const rows = await supa<Job[]>(`agent_jobs?agent=eq.${encodeURIComponent(slug)}&status=eq.running&order=created_at.asc&limit=20`);
  const out: Job[] = [];
  for (const j of rows) { const k = await expireIfStale(j); if (k && k.status === "running" && k.payload?.engine === "grokbot") out.push(k); }
  return out;
}

/** The Bot answered: store, close, deliver. */
export async function completeGrokJob(slug: string, jobId: number, reply: string, how: "mcp" | "rest"): Promise<NonNullable<Job["result"]>> {
  const job = await getJob(jobId);
  if (!job || job.agent !== slug) throw new Error(`No job ${jobId} for ${slug}`);
  if (job.status === "done") throw new Error(`Job ${jobId} is already answered`);
  if (job.status === "failed") throw new Error(`Job ${jobId} was marked failed (${job.error || "timed out"}); the person has been told — ask them to resend`);
  if (job.payload?.engine !== "grokbot") throw new Error(`Job ${jobId} is not a Grok Bot job (engine ${job.payload?.engine || "claude"})`);
  const text = String(reply || "").trim();
  if (!text) throw new Error("Empty reply");
  const via = job.kind === "telegram" ? "telegram" : job.kind === "task" ? "schedule" : job.payload?.event ? "event" : "console";
  let result: NonNullable<Job["result"]> = { reply: text, tools: [], engine: "grokbot" };
  if (job.kind === "task") {
    const hooks = await loadTaskHooks(job.agent);
    result = { ...(await hooks.finish(job, text, [])), engine: "grokbot" };
  } else {
    await supa("agent_messages", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ agent: slug, role: "agent", who: name(slug), who_email: "", body: text, run_id: `${via}-job:${job.id}`, meta: { via, engine: "grokbot", model: "grok-bot", replyHow: how, to: job.who, ...(job.payload?.telegram ? { telegramChat: String(job.payload.telegram.chatId) } : {}) } }) });
    if (job.kind === "telegram" && job.payload?.telegram) {
      const t = job.payload.telegram;
      try { const { sendMessage } = await import("./telegram"); result.telegramMessageIds = await sendMessage(slug, t.chatId, text, { replyTo: t.chatType === "private" ? undefined : t.messageId }); }
      catch (e) { result.summary = `reply not delivered to Telegram: ${e instanceof Error ? e.message : String(e)}`; }
    }
    if (job.payload?.event?.postToTeam) {
      try { const { sendMessage, teamChatId, telegramConfigured } = await import("./telegram"); if (telegramConfigured(slug) && teamChatId()) result.telegramMessageIds = await sendMessage(slug, teamChatId(), text); }
      catch (e) { result.summary = `team post failed: ${e instanceof Error ? e.message : String(e)}`; }
    }
  }
  await supa(`agent_jobs?id=eq.${job.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "done", result, finished_at: new Date().toISOString() }) });
  return result;
}

/** Engine + last-job summary per agent, for the board and the other apps' health rings. */
export interface EngineStatus { engine: "grokbot" | "claude" | "bridge"; label: string; up: boolean; lastJobAt: string | null; lastStatus: string | null; lastError: string | null; open: number }
export async function engineStatus(slugs: string[], brainOk: boolean): Promise<Record<string, EngineStatus>> {
  const out: Record<string, EngineStatus> = {};
  let rows: Pick<Job, "agent" | "status" | "created_at" | "finished_at" | "error">[] = [];
  try { rows = await supa(`agent_jobs?select=agent,status,created_at,finished_at,error&order=created_at.desc&limit=300`); } catch { rows = []; }
  const { grokbotWebhookConfigured } = await import("./grokbot");
  const { bridgeFor } = await import("./grokbot-bridge");
  for (const slug of slugs) {
    const engine = engineFor(slug);
    const mine = rows.filter((r) => r.agent === slug);
    const last = mine.find((r) => r.status === "done" || r.status === "failed");
    const bridgeUp = engine === "bridge" ? (slug === "ivory" ? grokbotWebhookConfigured() : Boolean(bridgeFor(slug)?.configured()) || (slug === "chris" && brainOk)) : false;
    out[slug] = {
      engine, label: ENGINE_LABEL[engine],
      up: engine === "grokbot" ? Boolean(grokbotWebhookUrl(slug)) : engine === "bridge" ? bridgeUp : brainOk,
      lastJobAt: last ? (last.finished_at || last.created_at) : null,
      lastStatus: last ? last.status : null,
      lastError: last?.status === "failed" ? (last.error || "").slice(0, 200) : null,
      open: mine.filter((r) => r.status === "running" || r.status === "pending").length,
    };
  }
  return out;
}
