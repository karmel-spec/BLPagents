import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/api";
import { checkReplyAuth, MELODY_TEXT_MAX, postReply } from "@/lib/melody-bridge";
import { supaConfigured } from "@/lib/supa";

export const dynamic = "force-dynamic";
export const maxDuration = 26;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Grok Bot Melody calls this with her reply.
 *   POST /api/melody/reply
 *   Authorization: Bearer $MELODY_CONSOLE_REPLY_KEY
 *   { "conversation_id": "<uuid>", "text": "..." }
 * Telegram conversations are delivered with TELEGRAM_BOT_TOKEN_MELODY.
 */
export async function POST(req: NextRequest) {
  const auth = checkReplyAuth(req.headers.get("authorization"));
  if (auth === "unset") return NextResponse.json({ error: "MELODY_CONSOLE_REPLY_KEY is not set" }, { status: 503 });
  if (auth === "bad") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = (await req.json().catch(() => ({}))) as { conversation_id?: string; text?: string };
    const conversationId = String(body.conversation_id || "").trim();
    const text = String(body.text || "").trim();
    if (!UUID.test(conversationId)) return NextResponse.json({ error: "conversation_id must be a uuid" }, { status: 400 });
    if (!text) return NextResponse.json({ error: "text is required" }, { status: 400 });
    if (text.length > MELODY_TEXT_MAX) return NextResponse.json({ error: `Keep a reply under ${MELODY_TEXT_MAX.toLocaleString()} characters` }, { status: 400 });
    if (!supaConfigured()) return NextResponse.json({ error: "Supabase is not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY)." }, { status: 503 });
    const result = await postReply(conversationId, text);
    return NextResponse.json({ ok: true, conversation_id: conversationId, message_id: result.messageId, telegram: result.telegram });
  } catch (err) {
    return jsonError(err, (err as { status?: number }).status || 502);
  }
}
