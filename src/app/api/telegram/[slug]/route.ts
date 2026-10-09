import { NextRequest, NextResponse } from "next/server";
import { getAgent } from "@/lib/agents";
import { agentReady, chatEnabled, createJob, dispatchJob } from "@/lib/agent-brain";
import { engineFor } from "@/lib/engine";
import { isGrokbotSlug } from "@/lib/grokbot-shared";
import { receiveChrisTelegram } from "@/lib/chris-bridge";
import { bridgeFor } from "@/lib/grokbot-bridge";
import { botToken, chatAllowed, displayName, getMe, sendMessage, webhookSecret, type TgUpdate } from "@/lib/telegram";

export const dynamic = "force-dynamic";
export const maxDuration = 26;

/**
 * Telegram webhook for one agent's bot: POST /api/telegram/arnold
 * Telegram must send X-Telegram-Bot-Api-Secret-Token = webhookSecret(slug)
 * (set by /api/telegram/arnold/setup). The message becomes a job in the same
 * agent_messages thread the console uses; the background runner replies.
 */
const SLUG = /^[a-z0-9-]{1,40}$/;
const seen = new Map<string, number>(); // update_id dedupe within one warm instance

export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  if (isGrokbotSlug(slug)) {
    return NextResponse.json({ ok: false, error: "Ivory answers through Ivory Grok Bot. This Telegram webhook is not used. Leave TELEGRAM_BOT_TOKEN_IVORY unset." }, { status: 410 });
  }
  if (!SLUG.test(slug) || !getAgent(slug) || !botToken(slug)) return NextResponse.json({ error: "No Telegram bot for this agent" }, { status: 404 });
  if (req.headers.get("x-telegram-bot-api-secret-token") !== webhookSecret(slug)) return NextResponse.json({ error: "bad secret" }, { status: 403 });
  const u = (await req.json().catch(() => null)) as TgUpdate | null;
  // @chrislarsonbot: same handler as the Netlify function (GrokBot bridge, or the in-app mind when the bridge env is unset).
  if (slug === "chris") {
    try { return NextResponse.json(await receiveChrisTelegram(u)); }
    catch (e) { return NextResponse.json({ ok: true, error: e instanceof Error ? e.message : String(e) }); }
  }
  // @edlarsonbot: Eddy Bot on Grok Bot. No Claude mind. Hermes Eddy never had Telegram wired.
  if (slug === "ed") {
    try { return NextResponse.json(await bridgeFor("ed")!.receiveTelegram(u)); }
    catch (e) { return NextResponse.json({ ok: true, error: e instanceof Error ? e.message : String(e) }); }
  }
  const msg = u?.message;
  // Always 200 from here on: a non-2xx makes Telegram retry the same update.
  if (!u || !msg || !msg.from || msg.from.is_bot) return NextResponse.json({ ok: true, skipped: "no message" });
  const key = `${slug}:${u.update_id}`;
  if (seen.has(key)) return NextResponse.json({ ok: true, skipped: "duplicate" });
  seen.set(key, Date.now());
  if (seen.size > 500) for (const [k, t] of seen) if (Date.now() - t > 600_000) seen.delete(k);

  const text = String(msg.text || msg.caption || "").trim();
  const chatId = msg.chat.id;
  const who = displayName(msg.from);
  try {
    if (!chatAllowed(slug, chatId, msg.from.id)) {
      if (msg.chat.type === "private") await sendMessage(slug, chatId, `Hi ${msg.from.first_name || "there"} — I only talk with the BLP team. Ask Karmel or Brigham to add your Telegram id (${msg.from.id}) to the console's TELEGRAM_ALLOWED_CHATS_${slug.toUpperCase()} list.`);
      return NextResponse.json({ ok: true, skipped: "chat not allowed" });
    }
    if (!text) return NextResponse.json({ ok: true, skipped: "no text" });
    // In groups only answer when addressed: @mention, reply to the bot, or a /command.
    if (msg.chat.type !== "private") {
      const me = await getMe(slug).catch(() => null);
      const mentioned = me?.username ? new RegExp(`@${me.username}\\b`, "i").test(text) : false;
      const replied = Boolean(me && msg.reply_to_message?.from?.id === me.id);
      if (!mentioned && !replied && !text.startsWith("/")) return NextResponse.json({ ok: true, skipped: "not addressed" });
    }
    const clean = text.replace(/@\w+bot\b/gi, "").trim();
    if (/^\/start\b/.test(clean)) {
      const a = getAgent(slug)!;
      await sendMessage(slug, chatId, `Hi ${msg.from.first_name || "there"}, ${a.name} here — ${a.role}. ${engineFor(slug) === "grokbot" ? "I run as a Grok Bot now, reached through the BLP Agent Console" : "Running in the cloud now (BLP Agent Console)"}, so I'm here even when the shop Mac is asleep. Ask me anything; I can read the vault and the Sales Console, and I only ever save drafts for a rep to approve.`);
      return NextResponse.json({ ok: true, replied: "start" });
    }
    if (!chatEnabled(slug) || !agentReady(slug)) {
      await sendMessage(slug, chatId, "My cloud brain isn't configured on this deployment yet (ANTHROPIC_API_KEY / VAULT_GITHUB_TOKEN / SUPABASE_*).");
      return NextResponse.json({ ok: true, skipped: "brain not configured" });
    }
    const body = clean.replace(/^\/(ask|arnold|a)\b\s*/i, "") || clean;
    const jobId = await createJob(slug, who, "", body.slice(0, 6000), "telegram", { telegram: { chatId, messageId: msg.message_id, chatTitle: msg.chat.title, chatType: msg.chat.type } });
    const job = await dispatchJob(jobId);
    return NextResponse.json({ ok: true, jobId, status: job?.status });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    try { await sendMessage(slug, chatId, `Sorry — something broke on my side: ${m.slice(0, 200)}`); } catch { /* ignore */ }
    return NextResponse.json({ ok: true, error: m });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, hint: "Telegram posts updates here. Use /api/telegram/<slug>/setup?key=… to register the webhook." });
}
