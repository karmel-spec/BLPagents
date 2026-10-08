import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireSessionOrKey } from "@/lib/api";
import { parseGoogleSession, SESSION_COOKIE } from "@/lib/auth";
import { bridgeReady, consoleThread, MELODY_TEXT_MAX, postConsoleMessage } from "@/lib/melody-bridge";

export const dynamic = "force-dynamic";
export const maxDuration = 26;

function caller(req: NextRequest): { name: string; email: string } {
  const google = parseGoogleSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (google) return { name: google.name || google.email, email: google.email };
  return { name: "Team", email: "" };
}

/** The shared console thread on Melody's agent page. */
export async function GET(req: NextRequest) {
  const guard = requireSessionOrKey(req);
  if (guard) return guard;
  const ready = bridgeReady();
  if (!ready.supabase) return NextResponse.json({ configured: false, bridge: false, conversation_id: null, messages: [], error: ready.why });
  try {
    const thread = await consoleThread();
    return NextResponse.json({ configured: true, bridge: ready.webhook, conversation_id: thread.conversationId, messages: thread.messages, error: ready.webhook ? undefined : ready.why });
  } catch (err) {
    return jsonError(err);
  }
}

/** A question, training ask, or work request from a signed-in teammate. */
export async function POST(req: NextRequest) {
  const guard = requireSessionOrKey(req);
  if (guard) return guard;
  const ready = bridgeReady();
  if (!ready.supabase) return NextResponse.json({ error: ready.why }, { status: 503 });
  try {
    const body = (await req.json().catch(() => ({}))) as { text?: string };
    const text = String(body.text || "").trim();
    if (!text) return NextResponse.json({ error: "Type a message first" }, { status: 400 });
    if (text.length > MELODY_TEXT_MAX) return NextResponse.json({ error: `Keep a message under ${MELODY_TEXT_MAX.toLocaleString()} characters` }, { status: 400 });
    const who = caller(req);
    const result = await postConsoleMessage({ name: who.name, email: who.email, text });
    return NextResponse.json({
      conversation_id: result.conversationId,
      message: result.message,
      forward: result.forward,
      error: result.forward.ok ? undefined : result.forward.error,
    });
  } catch (err) {
    return jsonError(err, 502);
  }
}
