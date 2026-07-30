import { NextRequest, NextResponse } from "next/server";
import { saveHeartbeat, type HeartbeatPayload } from "@/lib/agent-health";
import { isValidHeartbeatKey } from "@/lib/auth";
import { jsonError } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Agent machines report in here every ~10 minutes
 * (scripts/agent-heartbeat.mjs). Auth: the agent key in x-blp-key.
 * Reporters that already POST to the Sales Console can keep doing so —
 * both apps write the same "Agent Status" tab of the Leads Log.
 */
export async function POST(req: NextRequest) {
  if (!isValidHeartbeatKey(req.headers.get("x-blp-key"))) {
    return NextResponse.json({ error: "Invalid or missing x-blp-key" }, { status: 401 });
  }
  try {
    const payload = (await req.json()) as HeartbeatPayload;
    if (!payload?.machine || !Array.isArray(payload.agents)) {
      return NextResponse.json({ error: "Expected { machine, agents: [...] }" }, { status: 400 });
    }
    const count = await saveHeartbeat(payload);
    return NextResponse.json({ ok: true, agents: count });
  } catch (err) {
    return jsonError(err);
  }
}
