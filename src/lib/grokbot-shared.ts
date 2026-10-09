/**
 * Ivory Grok Bot — shared contract (safe to import from client components).
 * No secrets and no server clients live here. The webhook poster is grokbot.ts.
 *
 * One thread per agent: `thread_id` is the registry slug, stored as
 * `agent_messages.agent`. Ivory is the only slug on this runtime.
 */

export const GROKBOT_SLUGS = ["ivory"] as const;
export type GrokbotSlug = (typeof GROKBOT_SLUGS)[number];

export function isGrokbotSlug(slug: string): slug is GrokbotSlug {
  return (GROKBOT_SLUGS as readonly string[]).includes(slug);
}

/** How long the console waits for Ivory Grok Bot to insert her reply. */
export const GROKBOT_REPLY_TIMEOUT_MS = 4 * 60 * 1000;
export const GROKBOT_POLL_MS = 2500;

export const IVORY_MOVING_NOTICE =
  "Ivory is moving to Ivory Grok Bot and isn't connected on this deployment yet. Your message was not sent. She'll answer in this same chat once the webhook is set.";

export const IVORY_TIMEOUT_NOTICE =
  "Ivory is still working, but nothing has landed in this thread yet. Replies usually arrive within a few minutes — refresh this page in a little while and it will be here.";

export type GrokbotSource = "console" | "faces-widget" | "dispatch";

export function grokbotSource(value: unknown): GrokbotSource {
  if (value === "faces-widget" || value === "dispatch" || value === "console") return value;
  return "console";
}

export interface GrokbotHistoryTurn {
  id: number;
  role: "user" | "agent";
  who: string;
  text: string;
  at: string;
}

/** POST body for Ivory Grok Bot's inbound webhook. Version 1. */
export interface GrokbotWebhookPayload {
  v: 1;
  thread_id: string;
  message_id: number;
  agent: string;
  sender: { name: string; email: string };
  source: GrokbotSource;
  text: string;
  history: GrokbotHistoryTurn[];
}

const HISTORY_TURNS = 8;
const HISTORY_CHARS = 400;

export function excerptText(body: string, max = HISTORY_CHARS): string {
  const t = body.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export function grokbotPayload(input: {
  slug: string;
  messageId: number;
  senderName: string;
  senderEmail: string;
  source: GrokbotSource;
  text: string;
  history: GrokbotHistoryTurn[];
}): GrokbotWebhookPayload {
  return {
    v: 1,
    thread_id: input.slug,
    message_id: input.messageId,
    agent: input.slug,
    sender: { name: input.senderName || "Team", email: input.senderEmail || "" },
    source: input.source,
    text: input.text,
    history: input.history.slice(-HISTORY_TURNS).map((h) => ({
      id: h.id,
      role: h.role === "agent" ? "agent" : "user",
      who: h.who || "",
      text: excerptText(h.text),
      at: h.at || "",
    })),
  };
}

export interface ThreadMessageLike {
  id?: number;
  role: string;
  body?: string;
  run_id?: string | null;
  reply_to?: number | null;
  meta?: { in_reply_to?: number | null; tools?: string[] } | null;
}

function asAgentRole(role: string): string {
  return role === "assistant" ? "agent" : role;
}

/** A reply Ivory Grok Bot inserted for this user message. Explicit links win; an unlinked later agent row also counts. */
export function findGrokbotReply<T extends ThreadMessageLike>(messages: T[], userMessageId: number): T | undefined {
  const explicit = messages.find((m) => {
    if (asAgentRole(m.role) !== "agent") return false;
    if (m.reply_to === userMessageId) return true;
    if (m.meta?.in_reply_to === userMessageId) return true;
    if (m.run_id === `grokbot:${userMessageId}`) return true;
    return false;
  });
  if (explicit) return explicit;
  return messages.find((m) => {
    if (asAgentRole(m.role) !== "agent") return false;
    const id = m.id ?? 0;
    if (id <= userMessageId) return false;
    if (m.reply_to != null || m.meta?.in_reply_to != null) return false;
    if ((m.run_id || "").startsWith("grokbot:")) return false;
    return true;
  });
}

/** `run_id` Ivory Grok Bot may set so the console can match the reply without parsing meta. */
export function grokbotRunId(messageId: number): string {
  return `grokbot:${messageId}`;
}
