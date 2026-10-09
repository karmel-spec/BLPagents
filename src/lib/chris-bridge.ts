/**
 * Cristofori GrokBot bridge for the Chris entry points (slug stays `chris`).
 *
 * The shared implementation is grokbot-bridge.ts. This module keeps Chris's
 * function names and env vars (CHRIS_GROKBOT_WEBHOOK_URL, CHRIS_GROKBOT_WEBHOOK_KEY,
 * CHRIS_GROKBOT_WEBHOOK_KEY_HEADER, CHRIS_BRIDGE_SECRET) exactly as they were.
 *
 * Inbound: every user message (app chat or @chrislarsonbot) is POSTed to
 * CHRIS_GROKBOT_WEBHOOK_URL. The webhook should ack quickly; the reply comes
 * back later through POST /api/chris/reply.
 *
 * When CHRIS_GROKBOT_WEBHOOK_URL or CHRIS_GROKBOT_WEBHOOK_KEY is unset, callers
 * keep the in-app Claude mind (MINDS.chris). Nothing switches until cutover.
 */
import { bridgeFor, secretsMatch, type GrokbotInbound, type GrokbotReply, type GrokbotSender, type GrokbotTurn } from "./grokbot-bridge";
import type { TgUpdate } from "./telegram";

export const CHRIS = "chris";
export { secretsMatch };
export type ChrisSender = GrokbotSender;
export type ChrisTurn = GrokbotTurn;
export type ChrisInbound = GrokbotInbound;
export type ChrisReply = GrokbotReply;

function chris() {
  const b = bridgeFor(CHRIS);
  if (!b) throw new Error("Chris Grok Bot bridge is not registered");
  return b;
}

export function grokbotConfigured(): boolean {
  return chris().configured();
}

export function chrisStartText(firstName?: string): string {
  return chris().profile.startText(firstName);
}

export async function forwardToGrokbot(payload: ChrisInbound): Promise<void> {
  await chris().forward(payload);
}

/** App chat (Agent Console, Store Map, Sales App). Returns once the webhook has acked — the reply arrives later. */
export async function acceptAppMessage(input: { who: string; email: string; message: string; app: string; context?: Record<string, string> }): Promise<{ jobId: number; conversation_id: string }> {
  return chris().acceptApp(input);
}

/**
 * One Telegram update for @chrislarsonbot. Secret is checked by the caller.
 * Always resolves to a JSON body (Telegram retries non-2xx).
 * GrokBot configured → forward and return. Otherwise the in-app mind answers, same as before.
 */
export async function receiveChrisTelegram(u: TgUpdate | null): Promise<Record<string, unknown>> {
  return chris().receiveTelegram(u);
}

/** Deliver a Grok Bot reply into the conversation it names. */
export async function deliverChrisReply(body: ChrisReply): Promise<{ ok: true; duplicate?: boolean; jobId?: number }> {
  return chris().deliverReply(body);
}
