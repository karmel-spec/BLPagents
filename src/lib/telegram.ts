/**
 * Telegram Bot API for the cloud agent runtime (Brigham, 2026-10-07): each
 * agent's bot token is a Netlify env var — TELEGRAM_BOT_TOKEN_ARNOLD,
 * TELEGRAM_BOT_TOKEN_CLARA, … — so nothing depends on Karmel's Mac. Updates
 * arrive by webhook (/api/telegram/[slug]); replies go out through sendMessage.
 *
 * Other env:
 *   TELEGRAM_CHAT_ID                 the BLP Sales Team group (Arnold's briefings land here)
 *   TELEGRAM_ALLOWED_CHATS_<SLUG>    optional comma list of chat ids the bot answers
 *                                    (default: TELEGRAM_CHAT_ID + private chats whose user id is listed there)
 *   TELEGRAM_WEBHOOK_SECRET          optional; otherwise derived from the bot token
 */
import crypto from "crypto";

const API = "https://api.telegram.org";

export const botToken = (slug: string): string => process.env[`TELEGRAM_BOT_TOKEN_${slug.toUpperCase().replace(/-/g, "_")}`] || "";
export const telegramConfigured = (slug: string) => Boolean(botToken(slug));
export const teamChatId = (): string => process.env.TELEGRAM_CHAT_ID || "";

/** Secret Telegram echoes back in X-Telegram-Bot-Api-Secret-Token (letters, digits, _ and - only). */
export function webhookSecret(slug: string): string {
  if (slug.toLowerCase() === "chris" && process.env.TELEGRAM_WEBHOOK_SECRET_CHRIS) return process.env.TELEGRAM_WEBHOOK_SECRET_CHRIS;
  if (process.env.TELEGRAM_WEBHOOK_SECRET) return process.env.TELEGRAM_WEBHOOK_SECRET;
  return crypto.createHmac("sha256", "blp-telegram-webhook").update(botToken(slug)).digest("hex").slice(0, 48);
}

/** Chats this agent's bot will answer. Empty list = only the team group (and nothing else). */
export function allowedChats(slug: string): string[] {
  const own = (process.env[`TELEGRAM_ALLOWED_CHATS_${slug.toUpperCase().replace(/-/g, "_")}`] || "").split(",").map((x) => x.trim()).filter(Boolean);
  const team = teamChatId();
  return Array.from(new Set([...(team ? [team] : []), ...own]));
}
export const chatAllowed = (slug: string, chatId: string | number, fromId?: string | number) => {
  const ok = allowedChats(slug);
  return ok.includes(String(chatId)) || (fromId != null && ok.includes(String(fromId)));
};

async function tg<T>(slug: string, method: string, body: Record<string, unknown>): Promise<T> {
  const token = botToken(slug);
  if (!token) throw new Error(`TELEGRAM_BOT_TOKEN_${slug.toUpperCase()} is not set`);
  const r = await fetch(`${API}/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const j = (await r.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
  if (!r.ok || !j.ok) throw new Error(`Telegram ${method} ${r.status}: ${j.description || "failed"}`);
  return j.result as T;
}

export interface TgUser { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string }
export interface TgChat { id: number; type: "private" | "group" | "supergroup" | "channel"; title?: string; username?: string }
export interface TgMessage { message_id: number; from?: TgUser; chat: TgChat; date: number; text?: string; caption?: string; reply_to_message?: TgMessage; entities?: { type: string; offset: number; length: number }[] }
export interface TgUpdate { update_id: number; message?: TgMessage; edited_message?: TgMessage; channel_post?: TgMessage }

let meCache: { slug: string; at: number; me: TgUser } | null = null;
export async function getMe(slug: string): Promise<TgUser> {
  if (meCache && meCache.slug === slug && Date.now() - meCache.at < 3_600_000) return meCache.me;
  const me = await tg<TgUser>(slug, "getMe", {});
  meCache = { slug, at: Date.now(), me };
  return me;
}

export const displayName = (u?: TgUser) => u ? `${[u.first_name, u.last_name].filter(Boolean).join(" ").trim() || "Someone"}${u.username ? ` (@${u.username})` : ""}` : "Someone";

/** Markdown-ish text (what Claude writes) → Telegram HTML. */
export function toTelegramHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = md.replace(/\r/g, "").split("\n").map((raw) => {
    let line = raw;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) line = `**${heading[1].trim()}**`;
    line = line.replace(/^(\s*)[-*•]\s+/, "$1• ").replace(/^(\s*)(\d+)\.\s+/, "$1$2. ");
    // Pull links and code out before escaping, then put them back.
    const keep: string[] = [];
    line = line.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, t: string, u: string) => { keep.push(`<a href="${esc(u)}">${esc(t)}</a>`); return `\u0000${keep.length - 1}\u0000`; });
    line = line.replace(/`([^`]+)`/g, (_m, c: string) => { keep.push(`<code>${esc(c)}</code>`); return `\u0000${keep.length - 1}\u0000`; });
    line = esc(line);
    line = line.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/__(.+?)__/g, "<b>$1</b>").replace(/(^|\s)\*(?!\s)([^*]+?)\*(?=\s|$|[.,;:!?])/g, "$1<i>$2</i>").replace(/(^|\s)_(?!\s)([^_]+?)_(?=\s|$|[.,;:!?])/g, "$1<i>$2</i>");
    line = line.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => keep[Number(i)]);
    return line;
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
const stripMd = (md: string) => md.replace(/\*\*|__|`/g, "").replace(/^#{1,6}\s+/gm, "").replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)");

/** Split on paragraph/line boundaries so every piece fits Telegram's 4096-char limit. */
export function chunk(text: string, max = 3900): string[] {
  const out: string[] = [];
  let cur = "";
  for (const para of text.split(/\n(?=\n)/)) {
    const piece = para;
    if ((cur + piece).length <= max) { cur += piece; continue; }
    if (cur) out.push(cur);
    if (piece.length <= max) { cur = piece; continue; }
    cur = "";
    for (const line of piece.split("\n")) {
      if ((cur + "\n" + line).length > max) { if (cur) out.push(cur); cur = ""; }
      if (line.length > max) { for (let i = 0; i < line.length; i += max) out.push(line.slice(i, i + max)); continue; }
      cur = cur ? `${cur}\n${line}` : line;
    }
  }
  if (cur) out.push(cur);
  return out.map((x) => x.replace(/^\n+/, "")).filter(Boolean);
}

/** Send a (possibly long, markdown-ish) message; falls back to plain text if Telegram rejects the HTML. */
export async function sendMessage(slug: string, chatId: string | number, text: string, opts: { replyTo?: number } = {}): Promise<number[]> {
  const ids: number[] = [];
  const parts = chunk(text);
  for (let i = 0; i < parts.length; i++) {
    const base = { chat_id: chatId, disable_web_page_preview: true, ...(i === 0 && opts.replyTo ? { reply_parameters: { message_id: opts.replyTo, allow_sending_without_reply: true } } : {}) };
    try {
      const m = await tg<TgMessage>(slug, "sendMessage", { ...base, text: toTelegramHtml(parts[i]), parse_mode: "HTML" });
      ids.push(m.message_id);
    } catch {
      const m = await tg<TgMessage>(slug, "sendMessage", { ...base, text: stripMd(parts[i]) });
      ids.push(m.message_id);
    }
  }
  return ids;
}

export async function typing(slug: string, chatId: string | number): Promise<void> {
  try { await tg(slug, "sendChatAction", { chat_id: chatId, action: "typing" }); } catch { /* cosmetic */ }
}

export interface WebhookInfo { url: string; has_custom_certificate: boolean; pending_update_count: number; last_error_date?: number; last_error_message?: string; max_connections?: number; allowed_updates?: string[] }
export const getWebhookInfo = (slug: string) => tg<WebhookInfo>(slug, "getWebhookInfo", {});
export const setWebhook = (slug: string, url: string, dropPending = false) => tg<boolean>(slug, "setWebhook", { url, secret_token: webhookSecret(slug), allowed_updates: ["message"], drop_pending_updates: dropPending, max_connections: 10 });
export const deleteWebhook = (slug: string, dropPending = false) => tg<boolean>(slug, "deleteWebhook", { drop_pending_updates: dropPending });
