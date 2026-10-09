import { NextRequest, NextResponse } from "next/server";
import { AGENTS } from "@/lib/agents";
import { brainConfigured, chatEnabled } from "@/lib/agent-brain";
import { engineStatus } from "@/lib/grokbot-relay";
import { requireSessionOrKey, jsonError } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Which engine answers each agent right now (replaces the Hermes gateway
 * health, 2026-10-08). Session or team key, so the Store Map / Sales App /
 * Marketing app can draw their green/red rings from it:
 *   { configured: true, agents: { clara: { engine: "grokbot"|"claude"|"bridge", up, label, lastJobAt, lastStatus, lastError, open } } }
 */
export async function GET(req: NextRequest) {
  const guard = requireSessionOrKey(req);
  if (guard) return guard;
  try {
    const slugs = AGENTS.filter((a) => chatEnabled(a.slug)).map((a) => a.slug);
    const agents = await engineStatus(slugs, brainConfigured());
    return NextResponse.json({ configured: true, machine: "cloud (Agent Console)", agents });
  } catch (err) {
    return jsonError(err, 502);
  }
}
