/**
 * Cristofori GrokBot bridge for the Chris entry points (slug stays `chris`).
 *
 * Inbound: every user message (app chat or @chrislarsonbot) is POSTed to
 * CHRIS_GROKBOT_WEBHOOK_URL. The webhook should ack quickly; the reply comes
 * back later through POST /api/chris/reply.
 *
 * When CHRIS_GROKBOT_WEBHOOK_URL or CHRIS_GROKBOT_WEBHOOK_KEY is unset, callers
 * keep the in-app Claude mind (MINDS.chris). Nothing switches until cutover.
 */
import crypto from "crypto";
import { brainConfigured, chatEnabled, createJob, dispatchJob, getJob, history, type ChatMsg } from "./agent-brain";
import { supa, supaConfigured } from "./supa";
import { botToken, displayName, sendMessage, typing, type TgUpdate } from "./telegram";

export const CHRIS = "chris";
const HISTORY_TURNS = 10;
const seenUpdates = new Map<string, number>();

export interface ChrisSender {
  name: string;
  id: string;
}
export interface ChrisTurn {
  role: "user" | "agent";
  name: string;
  text: string;
  at: string;
}
/** Body posted to the Grok Bot webhook. Keys are the contract. */
export interface ChrisInbound {
  conversation_id: string;
  channel: "telegram" | "app";
  app: string;
  sender: ChrisSender;
  text: string;
  history: ChrisTurn[];
  sent_at: string;
}

export function grokbotConfigured(): boolean {
  return Boolean((process.env.CHRIS_GROKBOT_WEBHOOK_URL || "").trim() && (process.env.CHRIS_GROKBOT_WEBHOOK_KEY || "").trim());
}

/** Constant-time string compare. A length mismatch still burns a compare. */
export function secretsMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export function chrisStartText(firstName?: string): string {
  const name = (firstName || "there").replace(/[\r\n]/g, " ").slice(0, 40);
  return `Hi ${name} — Chris here (Cristofori), shop manager for Brigham Larson Pianos. Ask what's in the queue, what's stalled, which pianos are missing a before video, or paste Brigham's note and I'll turn it into a task card. Always include the serial number.\n\nI draft only. I never move a piano's stage or spot, never message customers or vendors, and never handle pay or schedules. Those still go through Brigham.`;
}

function webhookHeaders(): Record<string, string> {
  const key = (process.env.CHRIS_GROKBOT_WEBHOOK_KEY || "").trim();
  const header = (process.env.CHRIS_GROKBOT_WEBHOOK_KEY_HEADER || "").trim();
  if (header) {
    if (!/^[A-Za-z0-9-]+$/.test(header)) throw new Error("CHRIS_GROKBOT_WEBHOOK_KEY_HEADER must be letters, digits, and hyphens");
    return { [header]: key };
  }
  return { Authorization: `Bearer ${key}` };
}

export async function forwardToGrokbot(payload: ChrisInbound): Promise<void> {
  const url = (process.env.CHRIS_GROKBOT_WEBHOOK_URL || "").trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("CHRIS_GROKBOT_WEBHOOK_URL must be an http(s) URL");
  if (/\/api\/chris\/reply\b/.test(url)) throw new Error("CHRIS_GROKBOT_WEBHOOK_URL must be the Grok Bot webhook, not /api/chris/reply");
  const headers = { "content-type": "application/json", accept: "application/json", ...webhookHeaders() };
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000) });
  if (!r.ok) {
    const detail = (await r.text().catch(() => "")).slice(0, 180);
    throw new Error(`GrokBot webhook ${r.status}${detail ? `: ${detail}` : ""}`);
  }
}

function toTurn(m: ChatMsg): ChrisTurn {
  return {
    role: m.role === "agent" ? "agent" : "user",
    name: (m.role === "agent" ? m.who || "Cristofori" : m.who || "teammate").slice(0, 80),
    text: m.body.slice(0, 4000),
    at: m.created_at,
  };
}

async function priorTurns(match: (m: ChatMsg) => boolean): Promise<ChrisTurn[]> {
  if (!supaConfigured()) return [];
  const rows = await history(CHRIS, 40);
  return rows.filter(match).slice(-HISTORY_TURNS).map(toTurn);
}

function metaChannel(m: ChatMsg): string {
  return String(m.meta?.channel || "");
}
function metaVia(m: ChatMsg): string {
  return String(m.meta?.via || "");
}
const isTelegramRow = (m: ChatMsg) => metaChannel(m) === "telegram" || metaVia(m) === "telegram";

async function insertMessage(row: Record<string, unknown>): Promise<void> {
  await supa("agent_messages", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
}

async function patchJob(id: number, body: Record<string, unknown>): Promise<void> {
  await supa(`agent_jobs?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(body) });
}

async function failJob(id: number, error: string): Promise<void> {
  await patchJob(id, { status: "failed", error: error.slice(0, 500), finished_at: new Date().toISOString() }).catch(() => {});
}

/** App chat (Agent Console, Store Map, Sales App). Returns once the webhook has acked — the reply arrives later. */
export async function acceptAppMessage(input: { who: string; email: string; message: string; app: string }): Promise<{ jobId: number; conversation_id: string }> {
  if (!supaConfigured()) throw new Error("Chris's chat needs SUPABASE_URL and SUPABASE_SERVICE_KEY so the reply can land in the thread");
  const who = input.who.slice(0, 80) || "Team";
  const email = input.email.slice(0, 120);
  const app = input.app.trim().slice(0, 120) || "Agent Console";
  const text = input.message.trim();
  const sender: ChrisSender = { name: who, id: email || "team" };
  const historyTurns = await priorTurns((m) => !isTelegramRow(m));
  const jobId = await createJob(CHRIS, who, email, text, "grokbot", { channel: "app", app, sender });
  const conversation_id = `app:${jobId}`;
  await patchJob(jobId, { payload: { message: text, channel: "app", app, sender, conversation_id } });
  await insertMessage({
    agent: CHRIS,
    role: "user",
    who,
    who_email: email,
    body: text,
    meta: { via: "console", channel: "app", app, conversation_id },
  });
  const payload: ChrisInbound = {
    conversation_id,
    channel: "app",
    app,
    sender,
    text,
    history: historyTurns,
    sent_at: new Date().toISOString(),
  };
  try {
    await forwardToGrokbot(payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await failJob(jobId, msg);
    throw e;
  }
  return { jobId, conversation_id };
}

function chrisAllowed(chatId: string | number, fromId?: string | number): boolean {
  const own = (process.env.TELEGRAM_ALLOWED_CHATS_CHRIS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!own.length) return false;
  return own.includes(String(chatId)) || (fromId != null && own.includes(String(fromId)));
}

/**
 * One Telegram update for @chrislarsonbot. Secret is checked by the caller.
 * Always resolves to a JSON body (Telegram retries non-2xx).
 * GrokBot configured → forward and return. Otherwise the in-app mind answers, same as before.
 */
export async function receiveChrisTelegram(u: TgUpdate | null): Promise<Record<string, unknown>> {
  const msg = u?.message;
  if (!u || !msg || !msg.from || msg.from.is_bot) return { ok: true, skipped: "no message" };
  const key = `chris:${u.update_id}`;
  if (seenUpdates.has(key)) return { ok: true, skipped: "duplicate" };
  seenUpdates.set(key, Date.now());
  if (seenUpdates.size > 500) for (const [k, t] of seenUpdates) if (Date.now() - t > 600_000) seenUpdates.delete(k);

  const text = String(msg.text || msg.caption || "").trim();
  const chatId = msg.chat.id;
  const who = displayName(msg.from);
  if (!botToken(CHRIS)) return { ok: true, skipped: "TELEGRAM_BOT_TOKEN_CHRIS is not set" };
  try {
    if (!chrisAllowed(chatId, msg.from.id)) {
      if (msg.chat.type === "private") {
        await sendMessage(CHRIS, chatId, `Hi ${msg.from.first_name || "there"} — I only talk with the BLP team. Ask Karmel or Brigham to add your Telegram id (${msg.from.id}) to TELEGRAM_ALLOWED_CHATS_CHRIS.`);
      }
      return { ok: true, skipped: "chat not allowed" };
    }
    if (!text) return { ok: true, skipped: "no text" };
    if (msg.chat.type !== "private") {
      const { getMe } = await import("./telegram");
      const me = await getMe(CHRIS).catch(() => null);
      const mentioned = me?.username ? new RegExp(`@${me.username}\\b`, "i").test(text) : false;
      const replied = Boolean(me && msg.reply_to_message?.from?.id === me.id);
      if (!mentioned && !replied && !text.startsWith("/")) return { ok: true, skipped: "not addressed" };
    }
    const clean = text.replace(/@\w+bot\b/gi, "").trim();
    if (/^\/start\b/.test(clean)) {
      await sendMessage(CHRIS, chatId, chrisStartText(msg.from.first_name));
      return { ok: true, replied: "start" };
    }
    const body = (clean.replace(/^\/(ask|chris|c)\b\s*/i, "") || clean).slice(0, 6000);
    if (!grokbotConfigured()) {
      if (!chatEnabled(CHRIS) || !brainConfigured()) {
        await sendMessage(CHRIS, chatId, "My cloud brain isn't configured on this deployment yet (ANTHROPIC_API_KEY / VAULT_GITHUB_TOKEN / SUPABASE_*).");
        return { ok: true, skipped: "brain not configured" };
      }
      const jobId = await createJob(CHRIS, who, "", body, "telegram", { telegram: { chatId, messageId: msg.message_id, chatTitle: msg.chat.title, chatType: msg.chat.type } });
      const job = await dispatchJob(jobId);
      return { ok: true, jobId, status: job?.status };
    }
    if (!supaConfigured()) {
      await sendMessage(CHRIS, chatId, "I can't take that yet — the console's Supabase thread isn't configured.");
      return { ok: true, skipped: "supabase not configured" };
    }
    const conversation_id = `telegram:${chatId}`;
    const app = msg.chat.type === "private" ? "Telegram" : `Telegram · ${(msg.chat.title || "group").slice(0, 80)}`;
    const sender: ChrisSender = { name: who, id: String(msg.from.id) };
    const historyTurns = await priorTurns((m) => String(m.meta?.conversation_id || "") === conversation_id || String(m.meta?.telegramChat || "") === String(chatId));
    const jobId = await createJob(CHRIS, who, "", body, "grokbot", {});
    await patchJob(jobId, {
      payload: {
        message: body,
        channel: "telegram",
        app,
        sender,
        conversation_id,
        telegram: { chatId, messageId: msg.message_id, chatTitle: msg.chat.title, chatType: msg.chat.type },
      },
    });
    await insertMessage({
      agent: CHRIS,
      role: "user",
      who,
      who_email: "",
      body,
      meta: { via: "telegram", channel: "telegram", app, conversation_id, telegramChat: String(chatId) },
    });
    await typing(CHRIS, chatId);
    try {
      await forwardToGrokbot({
        conversation_id,
        channel: "telegram",
        app,
        sender,
        text: body,
        history: historyTurns,
        sent_at: new Date().toISOString(),
      });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      await failJob(jobId, m);
      await sendMessage(CHRIS, chatId, `Sorry — I couldn't reach Cristofori just now. Try again in a minute.`);
      return { ok: true, error: m.slice(0, 200) };
    }
    return { ok: true, jobId, status: "pending", bridged: true, conversation_id };
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    try { await sendMessage(CHRIS, chatId, `Sorry — something broke on my side: ${m.slice(0, 200)}`); } catch { /* ignore */ }
    return { ok: true, error: m.slice(0, 200) };
  }
}

export interface ChrisReply {
  conversation_id: string;
  channel: "telegram" | "app";
  text: string;
}

/** Deliver a Grok Bot reply into the conversation it names. */
export async function deliverChrisReply(body: ChrisReply): Promise<{ ok: true; duplicate?: boolean; jobId?: number }> {
  const conversation_id = body.conversation_id.trim();
  const text = body.text.trim();
  const channel = body.channel;
  if (!conversation_id || conversation_id.length > 200) throw Object.assign(new Error("conversation_id is required"), { status: 400 });
  if (!text) throw Object.assign(new Error("text is required"), { status: 400 });
  if (text.length > 16_000) throw Object.assign(new Error("text is too long"), { status: 400 });
  if (channel !== "telegram" && channel !== "app") throw Object.assign(new Error("channel must be telegram or app"), { status: 400 });
  if (!supaConfigured()) throw Object.assign(new Error("Supabase is not configured"), { status: 503 });

  const recent = await history(CHRIS, 15);
  const duplicate = recent.some((m) => m.role === "agent" && m.body === text && String(m.meta?.conversation_id || "") === conversation_id && Date.now() - Date.parse(m.created_at) < 120_000);
  if (duplicate) return { ok: true, duplicate: true };

  if (channel === "telegram") {
    const chatId = /^telegram:(-?\d+)$/.exec(conversation_id)?.[1];
    if (!chatId) throw Object.assign(new Error("telegram conversation_id must be telegram:<chat id>"), { status: 400 });
    if (!botToken(CHRIS)) throw Object.assign(new Error("TELEGRAM_BOT_TOKEN_CHRIS is not set"), { status: 503 });
    await insertMessage({
      agent: CHRIS,
      role: "agent",
      who: "Cristofori",
      who_email: "",
      body: text,
      meta: { via: "grokbot", channel: "telegram", conversation_id, telegramChat: chatId },
    });
    const ids = await sendMessage(CHRIS, chatId, text);
    const job = await oldestPending(conversation_id).catch(() => null);
    if (job) await patchJob(job.id, { status: "done", result: { reply: text, telegramMessageIds: ids }, finished_at: new Date().toISOString() });
    return { ok: true, jobId: job?.id };
  }

  const jobId = Number(/^app:(\d+)$/.exec(conversation_id)?.[1] || "");
  if (!jobId) throw Object.assign(new Error("app conversation_id must be app:<id>"), { status: 400 });
  const job = await getJob(jobId);
  if (job && job.agent === CHRIS && job.status === "done" && job.result?.reply === text) return { ok: true, duplicate: true, jobId };
  await insertMessage({
    agent: CHRIS,
    role: "agent",
    who: "Cristofori",
    who_email: "",
    body: text,
    run_id: `grokbot:${jobId}`,
    meta: { via: "grokbot", channel: "app", conversation_id },
  });
  if (job && job.agent === CHRIS) {
    await patchJob(jobId, { status: "done", result: { reply: text }, finished_at: new Date().toISOString() });
  }
  return { ok: true, jobId: job?.id };
}

async function oldestPending(conversationId: string): Promise<{ id: number } | null> {
  const q = `agent_jobs?agent=eq.${CHRIS}&kind=eq.grokbot&status=eq.pending&payload->>conversation_id=eq.${encodeURIComponent(conversationId)}&order=created_at.asc&limit=1&select=id`;
  const rows = await supa<{ id: number }[]>(q);
  return rows[0] || null;
}
