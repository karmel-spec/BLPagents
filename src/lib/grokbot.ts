/**
 * Deliver a turn to Ivory Grok Bot.
 *
 * The console stores the teammate's message in `agent_messages` (same table,
 * same slug `ivory`), then POSTs a compact payload to the Grok Bot inbound
 * webhook. The webhook only wakes the bot — the HTTP response is not the
 * reply. Ivory Grok Bot inserts the reply itself with the Supabase service
 * role. See docs/ivory-grokbot-bridge.md.
 *
 * If IVORY_GROKBOT_WEBHOOK_URL is unset, nothing is stored and nothing is
 * sent. Callers show IVORY_MOVING_NOTICE.
 */
import { supa, supaConfigured } from "./supa";
import {
  IVORY_MOVING_NOTICE,
  excerptText,
  grokbotPayload,
  grokbotSource,
  type GrokbotHistoryTurn,
  type GrokbotSource,
  type GrokbotWebhookPayload,
} from "./grokbot-shared";

export interface StoredTurn {
  id: number;
  agent: string;
  role: string;
  who: string;
  who_email: string;
  body: string;
  run_id: string | null;
  created_at: string;
  reply_to?: number | null;
  meta?: Record<string, unknown> | null;
}

export interface DeliverResult {
  provider: "grokbot";
  status: "pending" | "moving";
  configured: boolean;
  webhook: boolean;
  messageId?: number;
  notice?: string;
}

export function grokbotWebhookUrl(): string {
  return (process.env.IVORY_GROKBOT_WEBHOOK_URL || "").trim();
}

export function grokbotWebhookConfigured(): boolean {
  return grokbotWebhookUrl().length > 0;
}

/** Header name + value. Default is `Authorization: Bearer <IVORY_GROKBOT_WEBHOOK_KEY>`. */
export function grokbotWebhookHeaders(): Record<string, string> {
  const key = process.env.IVORY_GROKBOT_WEBHOOK_KEY || "";
  const name = (process.env.IVORY_GROKBOT_WEBHOOK_HEADER || "Authorization").trim() || "Authorization";
  const explicit = process.env.IVORY_GROKBOT_WEBHOOK_VALUE;
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  const value = explicit != null && explicit !== ""
    ? explicit
    : name.toLowerCase() === "authorization"
      ? (key ? `Bearer ${key}` : "")
      : key;
  if (value) headers[name] = value;
  return headers;
}

function asRows<T>(value: T[] | T | null): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

async function recentTurns(slug: string, limit: number): Promise<StoredTurn[]> {
  const rows = await supa<StoredTurn[]>(
    `agent_messages?agent=eq.${encodeURIComponent(slug)}&order=created_at.desc&limit=${limit}`,
  );
  return asRows(rows).reverse();
}

function toHistory(rows: StoredTurn[]): GrokbotHistoryTurn[] {
  return rows.map((r) => ({
    id: r.id,
    role: r.role === "agent" || r.role === "assistant" ? "agent" : "user",
    who: r.who || "",
    text: excerptText(r.body || ""),
    at: r.created_at || "",
  }));
}

async function postWebhook(payload: GrokbotWebhookPayload): Promise<void> {
  const url = grokbotWebhookUrl();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: grokbotWebhookHeaders(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
      redirect: "follow",
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`Ivory Grok Bot's webhook didn't answer (${why}). Your message is saved in the thread. Nothing was sent to Hermes or Claude.`);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 180);
    throw new Error(`Ivory Grok Bot didn't accept that message (HTTP ${res.status}${detail ? `: ${detail}` : ""}). It is saved in the thread. Nothing was sent to Hermes or Claude.`);
  }
}

/**
 * Store the user turn and wake Ivory Grok Bot. Does not wait for the reply.
 * Missing webhook URL → `{ status: "moving" }` and no insert.
 */
export async function deliverToGrokbot(opts: {
  slug: string;
  who: string;
  email: string;
  message: string;
  source: GrokbotSource;
}): Promise<DeliverResult> {
  const source = grokbotSource(opts.source);
  if (!grokbotWebhookConfigured()) {
    return { provider: "grokbot", status: "moving", configured: false, webhook: false, notice: IVORY_MOVING_NOTICE };
  }
  if (!supaConfigured()) {
    throw new Error("Ivory's chat thread needs SUPABASE_URL and SUPABASE_SERVICE_KEY on this deployment.");
  }
  const prior = await recentTurns(opts.slug, 8);
  const meta = { provider: "grokbot", via: source, source, status: "pending" };
  const inserted = asRows(await supa<StoredTurn[] | StoredTurn>("agent_messages", {
    method: "POST",
    body: JSON.stringify({
      agent: opts.slug,
      role: "user",
      who: opts.who || "Team",
      who_email: opts.email || "",
      body: opts.message,
      meta,
    }),
  }));
  const row = inserted[0];
  if (!row?.id) throw new Error("Could not store the message in Ivory's thread.");
  const payload = grokbotPayload({
    slug: opts.slug,
    messageId: row.id,
    senderName: opts.who || "Team",
    senderEmail: opts.email || "",
    source,
    text: opts.message,
    history: toHistory(prior),
  });
  try {
    await postWebhook(payload);
  } catch (err) {
    const failed = { ...meta, status: "delivery-failed" };
    await supa(`agent_messages?id=eq.${row.id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ meta: failed }),
    }).catch(() => { /* the row is still there for a person to read */ });
    throw err;
  }
  return { provider: "grokbot", status: "pending", configured: true, webhook: true, messageId: row.id };
}

export interface GrokbotDispatchRecord {
  at: string;
  slug: string;
  requester: string;
  input: string;
  run_id: string;
  status: "pending" | "completed";
  output: string | null;
}

/** Recent dispatch-box turns, newest first, for the Ivory console. */
export async function recentGrokbotDispatches(slug: string, limit = 8): Promise<GrokbotDispatchRecord[]> {
  if (!supaConfigured()) return [];
  const rows = await recentTurns(slug, 80);
  const dispatches = rows.filter((m) => m.role === "user" && (m.meta?.source === "dispatch" || m.meta?.via === "dispatch"));
  return dispatches.slice(-limit).reverse().map((m) => {
    const reply = rows.find((r) => {
      if (r.role !== "agent" && r.role !== "assistant") return false;
      if (r.reply_to === m.id) return true;
      const meta = r.meta as { in_reply_to?: number } | null;
      if (meta?.in_reply_to === m.id) return true;
      if (r.run_id === `grokbot:${m.id}`) return true;
      return false;
    });
    const who = m.who_email ? `${m.who} <${m.who_email}>` : (m.who || "Team");
    return {
      at: m.created_at,
      slug,
      requester: who,
      input: m.body,
      run_id: `grokbot:${m.id}`,
      status: reply ? "completed" : "pending",
      output: reply?.body || null,
    };
  });
}
