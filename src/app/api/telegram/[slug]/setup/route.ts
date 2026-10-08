import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireSessionOrKey } from "@/lib/api";
import { getAgent } from "@/lib/agents";
import { config } from "@/lib/config";
import { isGrokbotSlug } from "@/lib/grokbot-shared";
import { allowedChats, botToken, deleteWebhook, getMe, getWebhookInfo, setWebhook, teamChatId } from "@/lib/telegram";

export const dynamic = "force-dynamic";

/**
 * One-time webhook registration for an agent's bot (team key or a console session).
 *   GET  /api/telegram/arnold/setup?key=…               → bot identity + current webhook info
 *   POST /api/telegram/arnold/setup?key=…[&drop=1]      → setWebhook to this site's /api/telegram/arnold
 *   DELETE /api/telegram/arnold/setup?key=…             → deleteWebhook (hand the bot back to Hermes polling)
 * A bot can have one webhook OR long-polling (Hermes), never both — register
 * the webhook only when Hermes' Arnold Telegram adapter is stopped.
 */
async function state(slug: string) {
  const [me, hook] = await Promise.all([getMe(slug), getWebhookInfo(slug)]);
  return { bot: { id: me.id, username: me.username, name: me.first_name }, webhook: hook, allowedChats: allowedChats(slug), teamChatId: teamChatId() || null, expectedUrl: `${config.publicBaseUrl.replace(/\/$/, "")}/api/telegram/${slug}` };
}
async function guard(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const g = requireSessionOrKey(req);
  if (g) return { err: g };
  const { slug } = await ctx.params;
  if (isGrokbotSlug(slug)) return { err: NextResponse.json({ error: "Ivory answers through Ivory Grok Bot. Do not register a Telegram webhook, and leave TELEGRAM_BOT_TOKEN_IVORY unset." }, { status: 410 }) };
  if (!/^[a-z0-9-]{1,40}$/.test(slug) || !getAgent(slug)) return { err: NextResponse.json({ error: "Unknown agent" }, { status: 404 }) };
  if (!botToken(slug)) return { err: NextResponse.json({ error: `TELEGRAM_BOT_TOKEN_${slug.toUpperCase()} is not set on this deployment` }, { status: 503 }) };
  return { slug };
}
export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const g = await guard(req, ctx); if (g.err) return g.err;
  try { return NextResponse.json(await state(g.slug!)); } catch (e) { return jsonError(e, 502); }
}
export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const g = await guard(req, ctx); if (g.err) return g.err;
  try {
    if (!config.publicBaseUrl.startsWith("https://")) return NextResponse.json({ error: `PUBLIC_BASE_URL must be https for a Telegram webhook (is ${config.publicBaseUrl})` }, { status: 400 });
    const url = `${config.publicBaseUrl.replace(/\/$/, "")}/api/telegram/${g.slug}`;
    const ok = await setWebhook(g.slug!, url, req.nextUrl.searchParams.get("drop") === "1");
    return NextResponse.json({ ok, ...(await state(g.slug!)) });
  } catch (e) { return jsonError(e, 502); }
}
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const g = await guard(req, ctx); if (g.err) return g.err;
  try { const ok = await deleteWebhook(g.slug!, req.nextUrl.searchParams.get("drop") === "1"); return NextResponse.json({ ok, ...(await state(g.slug!)) }); } catch (e) { return jsonError(e, 502); }
}
