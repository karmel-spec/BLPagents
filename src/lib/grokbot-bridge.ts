/**
 * Per-agent Grok Bot bridge.
 *
 * Inbound: a user message (app chat or that agent's Telegram bot) is POSTed to
 * <PREFIX>_GROKBOT_WEBHOOK_URL. The webhook should ack quickly; the reply comes
 * back later through POST /api/<replySlug>/reply.
 *
 * Chris (prefix CHRIS, slug chris) keeps the original env names and, when the
 * webhook env is unset, the in-app Claude mind. Eddy (prefix EDDY, slug ed)
 * has no Claude mind — chat stays closed until the webhook env is set.
 * Telegram tokens follow the slug: TELEGRAM_BOT_TOKEN_CHRIS, TELEGRAM_BOT_TOKEN_ED.
 */
import crypto from "crypto";
import { brainConfigured, chatEnabled, createJob, dispatchJob, getJob, history, type ChatMsg } from "./agent-brain";
import { supa, supaConfigured } from "./supa";
import { botToken, displayName, sendMessage, typing, type TgUpdate } from "./telegram";

const HISTORY_TURNS = 10;
const seenUpdates = new Map<string, number>();

export interface GrokbotSender {
  name: string;
  id: string;
}
export interface GrokbotTurn {
  role: "user" | "agent";
  name: string;
  text: string;
  at: string;
  context?: Record<string, string>;
}
/**
 * Body posted to the Grok Bot webhook. Chris's messages omit `context`.
 * Eddy includes it when the caller passed a serial, piano, card URL, or other fields.
 */
export interface GrokbotInbound {
  conversation_id: string;
  channel: "telegram" | "app";
  app: string;
  sender: GrokbotSender;
  text: string;
  history: GrokbotTurn[];
  sent_at: string;
  context?: Record<string, string>;
}

export interface GrokbotReply {
  conversation_id: string;
  channel: "telegram" | "app";
  text: string;
}

export interface GrokbotProfile {
  slug: string;
  /** EDDY_GROKBOT_* / EDDY_BRIDGE_SECRET. Chris stays CHRIS so his env names do not change. */
  envPrefix: string;
  /** URL segment for the reply route: /api/chris/reply, /api/eddy/reply. */
  replySlug: string;
  /** Name stored on agent rows. */
  agentName: string;
  /** "couldn't reach {reachName}" */
  reachName: string;
  /** When the webhook env is missing, answer with the in-app Claude mind instead. Eddy: false. */
  claudeFallback: boolean;
  commandStrip: RegExp;
  startText: (firstName?: string) => string;
}

export const PROFILES: Record<string, GrokbotProfile> = {
  chris: {
    slug: "chris",
    envPrefix: "CHRIS",
    replySlug: "chris",
    agentName: "Cristofori",
    reachName: "Cristofori",
    claudeFallback: true,
    commandStrip: /^\/(ask|chris|c)\b\s*/i,
    startText: chrisStartText,
  },
  ed: {
    slug: "ed",
    envPrefix: "EDDY",
    replySlug: "eddy",
    agentName: "Eddy",
    reachName: "Eddy Bot",
    claudeFallback: false,
    commandStrip: /^\/(ask|eddy|ed)\b\s*/i,
    startText: eddyStartText,
  },
};

function chrisStartText(firstName?: string): string {
  const name = (firstName || "there").replace(/[\r\n]/g, " ").slice(0, 40);
  return `Hi ${name} — Chris here (Cristofori), shop manager for Brigham Larson Pianos. Ask what's in the queue, what's stalled, which pianos are missing a before video, or paste Brigham's note and I'll turn it into a task card. Always include the serial number.\n\nI draft only. I never move a piano's stage or spot, never message customers or vendors, and never handle pay or schedules. Those still go through Brigham.`;
}

function eddyStartText(firstName?: string): string {
  const name = (firstName || "there").replace(/[\r\n]/g, " ").slice(0, 40);
  return `Hi ${name} — Eddy here, BLP's video editor. Send a piano serial (or open me from a video card) and I'll look at that cut. I edit Shorts, Reels, HeyGen, translation, and captions, and I deliver them for review.\n\nI never post, upload, or change anything in Drive or Photos.`;
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

/** Keep caller context as short strings. Unknown shapes are dropped. `card` becomes `card_url`. */
export function sanitizeContext(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const out: Record<string, string> = {};
  for (const [rawKey, rawVal] of Object.entries(input as Record<string, unknown>)) {
    const key = rawKey === "card" ? "card_url" : rawKey;
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(key)) continue;
    if (typeof rawVal !== "string" && typeof rawVal !== "number") continue;
    const s = String(rawVal).replace(/[\r\n]/g, " ").trim().slice(0, 500);
    if (!s) continue;
    out[key] = s;
    if (Object.keys(out).length >= 12) break;
  }
  return Object.keys(out).length ? out : undefined;
}

function env(profile: GrokbotProfile, suffix: string): string {
  return (process.env[`${profile.envPrefix}_${suffix}`] || "").trim();
}

function tokenEnv(slug: string): string {
  return `TELEGRAM_BOT_TOKEN_${slug.toUpperCase().replace(/-/g, "_")}`;
}
function allowEnv(slug: string): string {
  return `TELEGRAM_ALLOWED_CHATS_${slug.toUpperCase().replace(/-/g, "_")}`;
}

export class GrokbotBridge {
  constructor(public readonly profile: GrokbotProfile) {}

  configured(): boolean {
    return Boolean(env(this.profile, "GROKBOT_WEBHOOK_URL") && env(this.profile, "GROKBOT_WEBHOOK_KEY"));
  }

  private webhookHeaders(): Record<string, string> {
    const key = env(this.profile, "GROKBOT_WEBHOOK_KEY");
    const header = env(this.profile, "GROKBOT_WEBHOOK_KEY_HEADER");
    if (header) {
      if (!/^[A-Za-z0-9-]+$/.test(header)) throw new Error(`${this.profile.envPrefix}_GROKBOT_WEBHOOK_KEY_HEADER must be letters, digits, and hyphens`);
      return { [header]: key };
    }
    return { Authorization: `Bearer ${key}` };
  }

  async forward(payload: GrokbotInbound): Promise<void> {
    const url = env(this.profile, "GROKBOT_WEBHOOK_URL");
    if (!/^https?:\/\//i.test(url)) throw new Error(`${this.profile.envPrefix}_GROKBOT_WEBHOOK_URL must be an http(s) URL`);
    if (new RegExp(`/api/${this.profile.replySlug}/reply\\b`).test(url)) {
      throw new Error(`${this.profile.envPrefix}_GROKBOT_WEBHOOK_URL must be the Grok Bot webhook, not /api/${this.profile.replySlug}/reply`);
    }
    const headers = { "content-type": "application/json", accept: "application/json", ...this.webhookHeaders() };
    const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000) });
    if (!r.ok) {
      const detail = (await r.text().catch(() => "")).slice(0, 180);
      throw new Error(`GrokBot webhook ${r.status}${detail ? `: ${detail}` : ""}`);
    }
  }

  private toTurn(m: ChatMsg): GrokbotTurn {
    const turn: GrokbotTurn = {
      role: m.role === "agent" ? "agent" : "user",
      name: (m.role === "agent" ? m.who || this.profile.agentName : m.who || "teammate").slice(0, 80),
      text: m.body.slice(0, 4000),
      at: m.created_at,
    };
    const ctx = sanitizeContext(m.meta?.context);
    if (ctx) turn.context = ctx;
    return turn;
  }

  private async priorTurns(match: (m: ChatMsg) => boolean): Promise<GrokbotTurn[]> {
    if (!supaConfigured()) return [];
    const rows = await history(this.profile.slug, 40);
    return rows.filter(match).slice(-HISTORY_TURNS).map((m) => this.toTurn(m));
  }

  private async insertMessage(row: Record<string, unknown>): Promise<void> {
    await supa("agent_messages", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(row) });
  }

  private async patchJob(id: number, body: Record<string, unknown>): Promise<void> {
    await supa(`agent_jobs?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(body) });
  }

  private async failJob(id: number, error: string): Promise<void> {
    await this.patchJob(id, { status: "failed", error: error.slice(0, 500), finished_at: new Date().toISOString() }).catch(() => {});
  }

  /** Own allow-list only (not TELEGRAM_CHAT_ID). Empty list = nobody. */
  private allowed(chatId: string | number, fromId?: string | number): boolean {
    const own = (process.env[allowEnv(this.profile.slug)] || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!own.length) return false;
    return own.includes(String(chatId)) || (fromId != null && own.includes(String(fromId)));
  }

  /** App chat. Returns once the webhook has acked — the reply arrives later. */
  async acceptApp(input: { who: string; email: string; message: string; app: string; context?: Record<string, string> }): Promise<{ jobId: number; conversation_id: string }> {
    const { slug, agentName } = this.profile;
    if (!supaConfigured()) {
      const label = slug === "chris" ? "Chris's" : `${agentName}'s`;
      throw new Error(`${label} chat needs SUPABASE_URL and SUPABASE_SERVICE_KEY so the reply can land in the thread`);
    }
    const who = input.who.slice(0, 80) || "Team";
    const email = input.email.slice(0, 120);
    const app = input.app.trim().slice(0, 120) || "Agent Console";
    const text = input.message.trim();
    const context = sanitizeContext(input.context);
    const sender: GrokbotSender = { name: who, id: email || "team" };
    const historyTurns = await this.priorTurns((m) => !isTelegramRow(m));
    const jobId = await createJob(slug, who, email, text, "grokbot", { channel: "app", app, sender, ...(context ? { context } : {}) });
    const conversation_id = `app:${jobId}`;
    await this.patchJob(jobId, { payload: { message: text, channel: "app", app, sender, conversation_id, ...(context ? { context } : {}) } });
    await this.insertMessage({
      agent: slug,
      role: "user",
      who,
      who_email: email,
      body: text,
      meta: { via: "console", channel: "app", app, conversation_id, ...(context ? { context } : {}) },
    });
    const payload: GrokbotInbound = {
      conversation_id,
      channel: "app",
      app,
      sender,
      text,
      history: historyTurns,
      sent_at: new Date().toISOString(),
      ...(context ? { context } : {}),
    };
    try {
      await this.forward(payload);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.failJob(jobId, msg);
      throw e;
    }
    return { jobId, conversation_id };
  }

  /**
   * One Telegram update. Secret is checked by the caller.
   * Always resolves to a JSON body (Telegram retries non-2xx).
   */
  async receiveTelegram(u: TgUpdate | null): Promise<Record<string, unknown>> {
    const { slug, agentName } = this.profile;
    const msg = u?.message;
    if (!u || !msg || !msg.from || msg.from.is_bot) return { ok: true, skipped: "no message" };
    const key = `${slug}:${u.update_id}`;
    if (seenUpdates.has(key)) return { ok: true, skipped: "duplicate" };
    seenUpdates.set(key, Date.now());
    if (seenUpdates.size > 500) for (const [k, t] of seenUpdates) if (Date.now() - t > 600_000) seenUpdates.delete(k);

    const text = String(msg.text || msg.caption || "").trim();
    const chatId = msg.chat.id;
    const who = displayName(msg.from);
    if (!botToken(slug)) return { ok: true, skipped: `${tokenEnv(slug)} is not set` };
    try {
      if (!this.allowed(chatId, msg.from.id)) {
        if (msg.chat.type === "private") {
          await sendMessage(slug, chatId, `Hi ${msg.from.first_name || "there"} — I only talk with the BLP team. Ask Karmel or Brigham to add your Telegram id (${msg.from.id}) to ${allowEnv(slug)}.`);
        }
        return { ok: true, skipped: "chat not allowed" };
      }
      if (!text) return { ok: true, skipped: "no text" };
      if (msg.chat.type !== "private") {
        const { getMe } = await import("./telegram");
        const me = await getMe(slug).catch(() => null);
        const mentioned = me?.username ? new RegExp(`@${me.username}\\b`, "i").test(text) : false;
        const replied = Boolean(me && msg.reply_to_message?.from?.id === me.id);
        if (!mentioned && !replied && !text.startsWith("/")) return { ok: true, skipped: "not addressed" };
      }
      const clean = text.replace(/@\w+bot\b/gi, "").trim();
      if (/^\/start\b/.test(clean)) {
        await sendMessage(slug, chatId, this.profile.startText(msg.from.first_name));
        return { ok: true, replied: "start" };
      }
      const body = (clean.replace(this.profile.commandStrip, "") || clean).slice(0, 6000);
      if (!this.configured()) {
        if (this.profile.claudeFallback) {
          if (!chatEnabled(slug) || !brainConfigured()) {
            await sendMessage(slug, chatId, "My cloud brain isn't configured on this deployment yet (ANTHROPIC_API_KEY / VAULT_GITHUB_TOKEN / SUPABASE_*).");
            return { ok: true, skipped: "brain not configured" };
          }
          const jobId = await createJob(slug, who, "", body, "telegram", { telegram: { chatId, messageId: msg.message_id, chatTitle: msg.chat.title, chatType: msg.chat.type } });
          const job = await dispatchJob(jobId);
          return { ok: true, jobId, status: job?.status };
        }
        await sendMessage(slug, chatId, `${agentName} isn't connected on this deployment yet (${this.profile.envPrefix}_GROKBOT_WEBHOOK_URL / ${this.profile.envPrefix}_GROKBOT_WEBHOOK_KEY).`);
        return { ok: true, skipped: "grokbot not configured" };
      }
      if (!supaConfigured()) {
        await sendMessage(slug, chatId, "I can't take that yet — the console's Supabase thread isn't configured.");
        return { ok: true, skipped: "supabase not configured" };
      }
      const conversation_id = `telegram:${chatId}`;
      const app = msg.chat.type === "private" ? "Telegram" : `Telegram · ${(msg.chat.title || "group").slice(0, 80)}`;
      const sender: GrokbotSender = { name: who, id: String(msg.from.id) };
      const historyTurns = await this.priorTurns((m) => String(m.meta?.conversation_id || "") === conversation_id || String(m.meta?.telegramChat || "") === String(chatId));
      const jobId = await createJob(slug, who, "", body, "grokbot", {});
      await this.patchJob(jobId, {
        payload: {
          message: body,
          channel: "telegram",
          app,
          sender,
          conversation_id,
          telegram: { chatId, messageId: msg.message_id, chatTitle: msg.chat.title, chatType: msg.chat.type },
        },
      });
      await this.insertMessage({
        agent: slug,
        role: "user",
        who,
        who_email: "",
        body,
        meta: { via: "telegram", channel: "telegram", app, conversation_id, telegramChat: String(chatId) },
      });
      await typing(slug, chatId);
      try {
        await this.forward({
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
        await this.failJob(jobId, m);
        await sendMessage(slug, chatId, `Sorry — I couldn't reach ${this.profile.reachName} just now. Try again in a minute.`);
        return { ok: true, error: m.slice(0, 200) };
      }
      return { ok: true, jobId, status: "pending", bridged: true, conversation_id };
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      try { await sendMessage(slug, chatId, `Sorry — something broke on my side: ${m.slice(0, 200)}`); } catch { /* ignore */ }
      return { ok: true, error: m.slice(0, 200) };
    }
  }

  /** Deliver a Grok Bot reply into the conversation it names. */
  async deliverReply(body: GrokbotReply): Promise<{ ok: true; duplicate?: boolean; jobId?: number }> {
    const { slug, agentName } = this.profile;
    const conversation_id = body.conversation_id.trim();
    const text = body.text.trim();
    const channel = body.channel;
    if (!conversation_id || conversation_id.length > 200) throw Object.assign(new Error("conversation_id is required"), { status: 400 });
    if (!text) throw Object.assign(new Error("text is required"), { status: 400 });
    if (text.length > 16_000) throw Object.assign(new Error("text is too long"), { status: 400 });
    if (channel !== "telegram" && channel !== "app") throw Object.assign(new Error("channel must be telegram or app"), { status: 400 });
    if (!supaConfigured()) throw Object.assign(new Error("Supabase is not configured"), { status: 503 });

    const recent = await history(slug, 15);
    const duplicate = recent.some((m) => m.role === "agent" && m.body === text && String(m.meta?.conversation_id || "") === conversation_id && Date.now() - Date.parse(m.created_at) < 120_000);
    if (duplicate) return { ok: true, duplicate: true };

    if (channel === "telegram") {
      const chatId = /^telegram:(-?\d+)$/.exec(conversation_id)?.[1];
      if (!chatId) throw Object.assign(new Error("telegram conversation_id must be telegram:<chat id>"), { status: 400 });
      if (!botToken(slug)) throw Object.assign(new Error(`${tokenEnv(slug)} is not set`), { status: 503 });
      await this.insertMessage({
        agent: slug,
        role: "agent",
        who: agentName,
        who_email: "",
        body: text,
        meta: { via: "grokbot", channel: "telegram", conversation_id, telegramChat: chatId },
      });
      const ids = await sendMessage(slug, chatId, text);
      const job = await this.oldestPending(conversation_id).catch(() => null);
      if (job) await this.patchJob(job.id, { status: "done", result: { reply: text, telegramMessageIds: ids }, finished_at: new Date().toISOString() });
      return { ok: true, jobId: job?.id };
    }

    const jobId = Number(/^app:(\d+)$/.exec(conversation_id)?.[1] || "");
    if (!jobId) throw Object.assign(new Error("app conversation_id must be app:<id>"), { status: 400 });
    const job = await getJob(jobId);
    if (job && job.agent === slug && job.status === "done" && job.result?.reply === text) return { ok: true, duplicate: true, jobId };
    await this.insertMessage({
      agent: slug,
      role: "agent",
      who: agentName,
      who_email: "",
      body: text,
      run_id: `grokbot:${jobId}`,
      meta: { via: "grokbot", channel: "app", conversation_id },
    });
    if (job && job.agent === slug) {
      await this.patchJob(jobId, { status: "done", result: { reply: text }, finished_at: new Date().toISOString() });
    }
    return { ok: true, jobId: job?.id };
  }

  private async oldestPending(conversationId: string): Promise<{ id: number } | null> {
    const q = `agent_jobs?agent=eq.${this.profile.slug}&kind=eq.grokbot&status=eq.pending&payload->>conversation_id=eq.${encodeURIComponent(conversationId)}&order=created_at.asc&limit=1&select=id`;
    const rows = await supa<{ id: number }[]>(q);
    return rows[0] || null;
  }
}

const bridges = new Map<string, GrokbotBridge>();

export function bridgeFor(slug: string): GrokbotBridge | null {
  const profile = PROFILES[slug];
  if (!profile) return null;
  let b = bridges.get(slug);
  if (!b) {
    b = new GrokbotBridge(profile);
    bridges.set(slug, b);
  }
  return b;
}

function isTelegramRow(m: ChatMsg): boolean {
  return String(m.meta?.channel || "") === "telegram" || String(m.meta?.via || "") === "telegram";
}
