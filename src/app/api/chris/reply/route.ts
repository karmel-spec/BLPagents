import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/api";
import { deliverChrisReply, secretsMatch } from "@/lib/chris-bridge";

export const dynamic = "force-dynamic";
export const maxDuration = 26;

/**
 * Cristofori GrokBot posts a finished reply here:
 *   POST /api/chris/reply
 *   header x-chris-bridge-secret: CHRIS_BRIDGE_SECRET
 *   { conversation_id, channel: "telegram"|"app", text }
 * Telegram replies go out through @chrislarsonbot. App replies are written to
 * the shared agent_messages thread so the open chat picks them up.
 */
function bridgeSecret(): string {
  return (process.env.CHRIS_BRIDGE_SECRET || "").trim();
}

export async function GET() {
  return NextResponse.json({ ok: true, hint: "POST {conversation_id, channel, text} with header x-chris-bridge-secret." });
}

export async function POST(req: NextRequest) {
  const expected = bridgeSecret();
  if (!expected) return NextResponse.json({ error: "CHRIS_BRIDGE_SECRET is not set" }, { status: 503 });
  const given = req.headers.get("x-chris-bridge-secret") || "";
  if (!secretsMatch(expected, given)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const b = (await req.json().catch(() => null)) as { conversation_id?: unknown; channel?: unknown; text?: unknown } | null;
    if (!b || typeof b !== "object") return NextResponse.json({ error: "Expected JSON {conversation_id, channel, text}" }, { status: 400 });
    if (b.channel !== "telegram" && b.channel !== "app") return NextResponse.json({ error: "channel must be telegram or app" }, { status: 400 });
    const result = await deliverChrisReply({
      conversation_id: String(b.conversation_id || ""),
      channel: b.channel,
      text: String(b.text || ""),
    });
    return NextResponse.json(result);
  } catch (err) {
    const status = typeof err === "object" && err && "status" in err && typeof (err as { status: unknown }).status === "number" ? (err as { status: number }).status : 502;
    return jsonError(err, status);
  }
}
