import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireSessionOrKey } from "@/lib/api";
import { getAgent } from "@/lib/agents";
import { config } from "@/lib/config";
import { allowedChats, botToken, deleteWebhook, getMe, getWebhookInfo, setWebhook, teamChatId } from "@/lib/telegram";

export const dynamic = "force-dynamic";

/**
 * One-time webhook registration for an agent's bot (team key or a console session).
 *   GET  /api/telegram/arnold/setup?key=…               → bot identity + current webhook info
 *   POST /api/telegram/arnold/setup?key=…[&drop=1]      → setWebhook to this site's /api/telegram/arnold
 *   DELETE /api/telegram/arnold/setup?key=…             → deleteWebhook (hand the bot back to Hermes polling)
 * A bot can have one webhook OR long-polling (Hermes), never both — register
 * the webhook only when Hermes' Arnold Telegram adapter is stopped.
 * Chris is the exception: POST /api/telegram/chris/setup refuses. @chrislarsonbot
 * is registered by hand against the Netlify function (CUTOVER.md).
 */
async function state(slug: string) {
  const [me, hook] = await Promise.all([getMe(slug), getWebhookInfo(slug)]);
  return { bot: { id: me.id, username: me.username, name: me.first_name }, webhook: hook, allowedChats: allowedChats(slug), teamChatId: teamChatId() || null, expectedUrl: `${config.publicBaseUrl.replace(/\/$/, "")}/api/telegram/${slug}` };
}
async function guard(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const g = requireSessionOrKey(req);
  if (g) return { err: g };
  const { slug } = await ctx.params;
  if (!/^[a-z0-9-]{1,40}$/.test(slug) || !getAgent(slug)) return { err: NextResponse.json({ error: "Unknown agent" }, { status: 404 }) };
  if (!botToken(slug)) return { err: NextResponse.json({ error: `TELEGRAM_BOT_TOKEN_${slug.toUpperCase()} is not set on this deployment` }, { status: 503 }) };
  return { slug };
}
export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const g = await guard(req, ctx); if (g.err) return g.err;
  try { return NextResponse.json(await state(g.slug!)); } catch (e) { return jsonError(e, 502); }
}
export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const session = requireSessionOrKey(req);
  if (session) return session;
  const { slug } = await ctx.params;
  // setWebhook is what disconnects Hermes. Chris's cutover is a manual curl to the
  // Netlify function — see CUTOVER.md. This route must not perform it, even when
  // the bot token is already on the deployment.
  if (slug === "chris") {
    const base = config.publicBaseUrl.replace(/\/$/, "");
    return NextResponse.json({
      error: "Don't register @chrislarsonbot from this route. Its webhook is the Netlify function, and setWebhook is the manual step that disconnects the Hermes poller. See CUTOVER.md.",
      webhookUrl: `${base}/.netlify/functions/chris-telegram`,
    }, { status: 400 });
  }
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
