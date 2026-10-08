/**
 * Bridge between the team and Grok Bot Melody.
 *
 * Inbound (Telegram webhook or the console page) is stored in Supabase, then
 * POSTed to MELODY_GROKBOT_WEBHOOK_URL. Melody replies to POST /api/melody/reply;
 * Telegram conversations are delivered with TELEGRAM_BOT_TOKEN_MELODY.
 *
 * Env:
 *   MELODY_GROKBOT_WEBHOOK_URL          Grok Bot routine webhook (required to forward)
 *   MELODY_GROKBOT_WEBHOOK_KEY          sender key copied from that routine's panel
 *   MELODY_GROKBOT_WEBHOOK_KEY_HEADER   header that carries the key (default X-Webhook-Key).
 *                                       If this is Authorization and the key has no scheme,
 *                                       the value is sent as "Bearer <key>".
 *   MELODY_TELEGRAM_ALLOWLIST           comma-separated Telegram user ids. Empty = nobody.
 *   MELODY_CONSOLE_REPLY_KEY            Bearer token Grok Bot sends on /api/melody/reply
 *   TELEGRAM_BOT_TOKEN_MELODY           existing per-agent bot token
 *   PUBLIC_BASE_URL                     used to build reply_url (https in production)
 *   SUPABASE_URL / SUPABASE_SERVICE_KEY tables melody_conversations, melody_messages
 */
import crypto from "crypto";
import { NextResponse } from "next/server";
import { config } from "./config";
import { supa, supaConfigured } from "./supa";
import { displayName, getMe, sendMessage, typing, type TgUpdate } from "./telegram";

const SLUG = "melody";
const CONSOLE_KEY = "console:team";
const TEXT_MAX = 6000;

export interface MelodyMessageRow {
  id: string;
  conversation_id: string;
  direction: "in" | "out";
  sender_name: string;
  sender_email: string;
  sender_role: string;
  body: string;
  telegram_update_id: string | null;
  telegram_message_id: string | null;
  forward_error: string | null;
  created_at: string;
}

interface MelodyConversationRow {
  id: string;
  source: "telegram" | "console";
  external_key: string;
  telegram_chat_id: string | null;
  sender_name: string;
  sender_email: string;
  sender_role: string;
  created_at: string;
  updated_at: string;
}

export interface MelodyPublicMessage {
  id: string;
  conversation_id: string;
  direction: "in" | "out";
  sender_name: string;
  sender_email: string;
  body: string;
  forward_error: string | null;
  created_at: string;
}

export function melodyTelegramAllowlist(): string[] {
  return (process.env.MELODY_TELEGRAM_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function melodyTelegramAllowed(userId: string | number): boolean {
  return melodyTelegramAllowlist().includes(String(userId));
}

export function webhookKeyHeader(): string {
  return (process.env.MELODY_GROKBOT_WEBHOOK_KEY_HEADER || "X-Webhook-Key").trim() || "X-Webhook-Key";
}

/** Header value for the Grok Bot webhook. Authorization without a scheme becomes "Bearer <key>". */
export function webhookKeyValue(key: string, header = webhookKeyHeader()): string {
  if (/^authorization$/i.test(header) && !/^\s*(bearer|basic)\s+/i.test(key)) return `Bearer ${key}`;
  return key;
}

export function bridgeReady(): { supabase: boolean; webhook: boolean; why?: string } {
  const supabase = supaConfigured();
  const webhook = Boolean(process.env.MELODY_GROKBOT_WEBHOOK_URL && process.env.MELODY_GROKBOT_WEBHOOK_KEY);
  if (!supabase) return { supabase, webhook, why: "Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY)." };
  if (!webhook) return { supabase, webhook, why: "Grok Bot webhook is not configured (MELODY_GROKBOT_WEBHOOK_URL / MELODY_GROKBOT_WEBHOOK_KEY)." };
  return { supabase, webhook };
}

export function replyUrl(): string {
  return `${config.publicBaseUrl.replace(/\/$/, "")}/api/melody/reply`;
}

export function checkReplyAuth(authorization: string | null): "ok" | "unset" | "bad" {
  const key = process.env.MELODY_CONSOLE_REPLY_KEY || "";
  if (!key) return "unset";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization || "");
  if (!match) return "bad";
  const given = Buffer.from(match[1]);
  const want = Buffer.from(key);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return "bad";
  return "ok";
}

function replyInstruction(conversationId: string): string {
  return `Reply by POSTing JSON {"conversation_id":"${conversationId}","text":"your reply"} to reply_url with header Authorization: Bearer <MELODY_CONSOLE_REPLY_KEY>. The console saves the reply and, when source is telegram, sends it to that Telegram chat.`;
}

export function toPublic(row: MelodyMessageRow): MelodyPublicMessage {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    direction: row.direction,
    sender_name: row.sender_name,
    sender_email: row.sender_email,
    body: row.body,
    forward_error: row.forward_error,
    created_at: row.created_at,
  };
}

async function upsertConversation(input: {
  source: "telegram" | "console";
  externalKey: string;
  telegramChatId: string | null;
  senderName: string;
  senderEmail: string;
  senderRole: string;
}): Promise<MelodyConversationRow> {
  const rows = await supa<MelodyConversationRow[]>("melody_conversations?on_conflict=external_key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({
      source: input.source,
      external_key: input.externalKey,
      telegram_chat_id: input.telegramChatId,
      sender_name: input.senderName,
      sender_email: input.senderEmail,
      sender_role: input.senderRole,
      updated_at: new Date().toISOString(),
    }),
  });
  const row = rows?.[0];
  if (!row?.id) throw new Error("Supabase did not return a melody conversation");
  return row;
}

async function insertMessage(input: {
  conversationId: string;
  direction: "in" | "out";
  senderName: string;
  senderEmail: string;
  senderRole: string;
  body: string;
  telegramUpdateId?: string | null;
}): Promise<MelodyMessageRow> {
  const rows = await supa<MelodyMessageRow[]>("melody_messages", {
    method: "POST",
    body: JSON.stringify({
      conversation_id: input.conversationId,
      direction: input.direction,
      sender_name: input.senderName,
      sender_email: input.senderEmail,
      sender_role: input.senderRole,
      body: input.body,
      telegram_update_id: input.telegramUpdateId || null,
    }),
  });
  const row = rows?.[0];
  if (!row?.id) throw new Error("Supabase did not return a melody message");
  return row;
}

async function markForward(id: string, error: string | null): Promise<void> {
  await supa(`melody_messages?id=eq.${id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ forward_error: error }),
  });
}

export async function forwardToGrok(payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const url = (process.env.MELODY_GROKBOT_WEBHOOK_URL || "").trim();
  const key = process.env.MELODY_GROKBOT_WEBHOOK_KEY || "";
  if (!url || !key) return { ok: false, error: "MELODY_GROKBOT_WEBHOOK_URL and MELODY_GROKBOT_WEBHOOK_KEY must be set" };
  const header = webhookKeyHeader();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", [header]: webhookKeyValue(key, header) },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Grok Bot webhook ${res.status}: ${text.slice(0, 180)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function inboundPayload(input: {
  source: "telegram" | "console";
  conversationId: string;
  messageId: string;
  senderName: string;
  senderRole: string;
  senderEmail: string;
  telegramChatId: string | null;
  text: string;
  timestamp: string;
}): Record<string, unknown> {
  return {
    source: input.source,
    conversation_id: input.conversationId,
    message_id: input.messageId,
    sender_name: input.senderName,
    sender_role: input.senderRole,
    sender_email: input.senderEmail,
    telegram_chat_id: input.telegramChatId,
    text: input.text,
    timestamp: input.timestamp,
    reply_url: replyUrl(),
    instruction: replyInstruction(input.conversationId),
  };
}

/** Store one inbound message and forward it to Grok Bot. */
export async function acceptInbound(input: {
  source: "telegram" | "console";
  externalKey: string;
  telegramChatId: string | null;
  senderName: string;
  senderEmail: string;
  senderRole: string;
  text: string;
  telegramUpdateId?: string | null;
}): Promise<{ conversationId: string; message: MelodyPublicMessage; forward: { ok: boolean; error?: string }; duplicate?: boolean }> {
  if (input.telegramUpdateId) {
    const prior = await supa<MelodyMessageRow[]>(
      `melody_messages?telegram_update_id=eq.${encodeURIComponent(input.telegramUpdateId)}&limit=1`
    );
    if (prior?.[0]) {
      return { conversationId: prior[0].conversation_id, message: toPublic(prior[0]), forward: { ok: !prior[0].forward_error, error: prior[0].forward_error || undefined }, duplicate: true };
    }
  }
  const conversation = await upsertConversation(input);
  const row = await insertMessage({
    conversationId: conversation.id,
    direction: "in",
    senderName: input.senderName,
    senderEmail: input.senderEmail,
    senderRole: input.senderRole,
    body: input.text,
    telegramUpdateId: input.telegramUpdateId,
  });
  const forward = await forwardToGrok(inboundPayload({
    source: input.source,
    conversationId: conversation.id,
    messageId: row.id,
    senderName: input.senderName,
    senderRole: input.senderRole,
    senderEmail: input.senderEmail,
    telegramChatId: input.telegramChatId,
    text: input.text,
    timestamp: row.created_at,
  }));
  if (!forward.ok) await markForward(row.id, forward.error || "forward failed");
  return { conversationId: conversation.id, message: { ...toPublic(row), forward_error: forward.ok ? null : forward.error || "forward failed" }, forward };
}

export async function consoleThread(): Promise<{ conversationId: string | null; messages: MelodyPublicMessage[] }> {
  const found = await supa<MelodyConversationRow[]>(
    `melody_conversations?external_key=eq.${encodeURIComponent(CONSOLE_KEY)}&limit=1`
  );
  const conversation = found?.[0];
  if (!conversation) return { conversationId: null, messages: [] };
  const rows = await supa<MelodyMessageRow[]>(
    `melody_messages?conversation_id=eq.${conversation.id}&order=created_at.asc&limit=200`
  );
  return { conversationId: conversation.id, messages: (rows || []).map(toPublic) };
}

export async function postConsoleMessage(input: { name: string; email: string; text: string }) {
  return acceptInbound({
    source: "console",
    externalKey: CONSOLE_KEY,
    telegramChatId: null,
    senderName: input.name,
    senderEmail: input.email,
    senderRole: "team",
    text: input.text,
  });
}

export async function postReply(conversationId: string, text: string): Promise<{ messageId: string; telegram: boolean }> {
  const found = await supa<MelodyConversationRow[]>(
    `melody_conversations?id=eq.${conversationId}&limit=1`
  );
  const conversation = found?.[0];
  if (!conversation) {
    const err = new Error("Unknown conversation_id");
    (err as { status?: number }).status = 404;
    throw err;
  }
  const row = await insertMessage({
    conversationId: conversation.id,
    direction: "out",
    senderName: "Melody",
    senderEmail: "",
    senderRole: "agent",
    body: text,
  });
  await supa(`melody_conversations?id=eq.${conversation.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ updated_at: new Date().toISOString() }),
  });
  if (conversation.source === "telegram" && conversation.telegram_chat_id) {
    try {
      const ids = await sendMessage(SLUG, conversation.telegram_chat_id, text);
      if (ids[0]) {
        await supa(`melody_messages?id=eq.${row.id}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ telegram_message_id: String(ids[0]) }),
        });
      }
    } catch (err) {
      await supa(`melody_messages?id=eq.${row.id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } }).catch(() => {});
      throw err;
    }
    return { messageId: row.id, telegram: true };
  }
  return { messageId: row.id, telegram: false };
}

const seen = new Map<string, number>();

function addressed(text: string, meId: number | undefined, meUsername: string | undefined, replyFromId: number | undefined): boolean {
  if (text.startsWith("/")) return true;
  if (meUsername && new RegExp(`@${meUsername}\\b`, "i").test(text)) return true;
  if (meId && replyFromId === meId) return true;
  return false;
}

/**
 * Telegram webhook body for @melodylarsonbot, after the route has checked the
 * secret header and that TELEGRAM_BOT_TOKEN_MELODY is set. Always 200 once a
 * message is in hand so Telegram does not retry a handled update.
 */
export async function handleMelodyTelegramUpdate(update: TgUpdate | null): Promise<NextResponse> {
  const msg = update?.message;
  if (!update || !msg || !msg.from || msg.from.is_bot) return NextResponse.json({ ok: true, skipped: "no message" });
  const dedupeKey = `${update.update_id}`;
  if (seen.has(dedupeKey)) return NextResponse.json({ ok: true, skipped: "duplicate" });
  seen.set(dedupeKey, Date.now());
  if (seen.size > 500) for (const [k, t] of seen) if (Date.now() - t > 600_000) seen.delete(k);

  const raw = String(msg.text || msg.caption || "").trim();
  const chatId = msg.chat.id;
  const fromId = msg.from.id;
  if (!raw) return NextResponse.json({ ok: true, skipped: "no text" });

  let mentioned = false;
  if (msg.chat.type !== "private") {
    const me = await getMe(SLUG).catch(() => null);
    mentioned = addressed(raw, me?.id, me?.username, msg.reply_to_message?.from?.id);
    if (!mentioned) return NextResponse.json({ ok: true, skipped: "not addressed" });
  }

  if (!melodyTelegramAllowed(fromId)) {
    const who = msg.from.first_name || "there";
    await sendMessage(SLUG, chatId, `Hi ${who} — Melody only talks with the BLP team. Ask Karmel or Brigham to add your Telegram id (${fromId}).`);
    return NextResponse.json({ ok: true, skipped: "not on the allowlist" });
  }

  const text = raw.replace(/@\w+bot\b/gi, "").replace(/^\/(start|ask)\b\s*/i, "").trim().slice(0, TEXT_MAX);
  if (!text) {
    const who = msg.from.first_name || "there";
    await sendMessage(SLUG, chatId, `Hi ${who}, Melody here. Send a question, a training ask, or a work request and I'll reply in this chat.`);
    return NextResponse.json({ ok: true, replied: "start" });
  }

  if (!supaConfigured()) {
    await sendMessage(SLUG, chatId, "I can't take that yet — the console's message store isn't configured. Ask Karmel.");
    return NextResponse.json({ ok: true, error: "supabase not configured" });
  }

  try {
    await typing(SLUG, chatId);
    const result = await acceptInbound({
      source: "telegram",
      externalKey: `telegram:${chatId}`,
      telegramChatId: String(chatId),
      senderName: displayName(msg.from),
      senderEmail: "",
      senderRole: "telegram",
      text,
      telegramUpdateId: String(update.update_id),
    });
    if (!result.duplicate && !result.forward.ok) {
      await sendMessage(SLUG, chatId, "I saved your message, but I couldn't reach my desk just now. Ask again in a minute if I don't reply.");
    }
    return NextResponse.json({ ok: true, conversation_id: result.conversationId, message_id: result.message.id, forwarded: result.forward.ok, duplicate: Boolean(result.duplicate) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/duplicate key|23505/i.test(message)) return NextResponse.json({ ok: true, skipped: "duplicate" });
    try { await sendMessage(SLUG, chatId, `Sorry — something broke on my side: ${message.slice(0, 200)}`); } catch { /* ignore */ }
    return NextResponse.json({ ok: true, error: message });
  }
}

export const MELODY_TEXT_MAX = TEXT_MAX;
export const melodyConsoleKey = CONSOLE_KEY;
