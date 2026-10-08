import { NextRequest, NextResponse } from "next/server";
import { readAgentHealth } from "@/lib/agent-health";
import { requireSession, jsonError } from "@/lib/api";
import { AGENTS } from "@/lib/agents";

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

    // Cloud Grok Bot agents (Ivory) are healthy without a Mac heartbeat.
    // A stale Hermes row must not paint them offline.
    for (const a of AGENTS) {
      if (a.deviceHeartbeat !== false) continue;
      health[a.slug] = {
        slug: a.slug,
        dot: "healthy",
        machine: "Grok Bot (cloud)",
        reportedAt: "",
        fresh: true,
        online: true,
        cronsActive: 0,
        cronsOk: 0,
        issues: [],
        note: "Cloud Grok Bot — no Mac heartbeat",
      };
    }

    return NextResponse.json({ health });
  } catch (err) {
    return jsonError(err);
  }
}
