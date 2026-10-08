import { NextRequest, NextResponse } from "next/server";
import { readAgentHealth } from "@/lib/agent-health";
import { AGENTS, isGrokBotRuntime } from "@/lib/agents";
import { requireSession, jsonError } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Fleet health for the Mission Control board. */
export async function GET(req: NextRequest) {
  const guard = requireSession(req);
  if (guard) return guard;
  try {
    const health = await readAgentHealth();

    // Independent signal for Arnold: is his tunnel reachable from the internet?
    if (health.arnold) {
      try {
        const res = await fetch("https://arnold.brighamlarsonpianos.com/health", {
          signal: AbortSignal.timeout(5000),
          cache: "no-store",
        });
        if (!res.ok) throw new Error(String(res.status));
      } catch {
        health.arnold.issues.push("tunnel unreachable from the internet (Mac asleep or cloudflared down)");
        if (health.arnold.dot === "healthy") health.arnold.dot = "attention";
      }
    }

    // Grok Bot agents are not Hermes profiles. A missing or stale Mac
    // heartbeat must not paint them offline once that profile is switched off.
    for (const agent of AGENTS) {
      if (isGrokBotRuntime(agent.runtime)) delete health[agent.slug];
    }

    return NextResponse.json({ health });
  } catch (err) {
    return jsonError(err);
  }
}
