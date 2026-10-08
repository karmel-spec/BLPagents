/**
 * Webhook for @chrislarsonbot. Telegram must send
 * X-Telegram-Bot-Api-Secret-Token = TELEGRAM_WEBHOOK_SECRET_CHRIS.
 *
 * Registering this URL with setWebhook is the cutover that stops Hermes
 * polling the same bot. Do that by hand, after the Hermes poller is stopped.
 * See CUTOVER.md. This function does not call setWebhook.
 *
 *   POST https://blpagents.netlify.app/.netlify/functions/chris-telegram
 */
import { receiveChrisTelegram, secretsMatch } from "../../src/lib/chris-bridge";
import type { TgUpdate } from "../../src/lib/telegram";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default async (req: Request) => {
  if (req.method === "GET") {
    return json({ ok: true, hint: "Telegram posts updates here. Register with setWebhook only at cutover — see CUTOVER.md. This URL does not call setWebhook." });
  }
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const expected = (process.env.TELEGRAM_WEBHOOK_SECRET_CHRIS || "").trim();
  const given = req.headers.get("x-telegram-bot-api-secret-token") || "";
  if (!expected || !secretsMatch(expected, given)) return json({ error: "bad secret" }, 401);
  const update = (await req.json().catch(() => null)) as TgUpdate | null;
  try {
    return json(await receiveChrisTelegram(update));
  } catch (e) {
    return json({ ok: true, error: e instanceof Error ? e.message.slice(0, 200) : "error" });
  }
};
