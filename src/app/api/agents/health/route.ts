import { NextRequest, NextResponse } from "next/server";
import { readAgentHealth, type AgentHealth } from "@/lib/agent-health";
import { brainConfigured, chatEnabled } from "@/lib/agent-brain";
import { engineStatus } from "@/lib/grokbot-relay";
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

    // Cloud engines (fleet relay / per-agent bridge / in-app runner) have no Mac
    // heartbeat: an agent whose engine is configured is "healthy" from its last job,
    // "attention" when its last job failed. A fresh Hermes heartbeat (overlap period) still wins.
    try {
      const slugs = AGENTS.filter((a) => chatEnabled(a.slug)).map((a) => a.slug);
      const eng = await engineStatus(slugs, brainConfigured());
      for (const slug of slugs) {
        const e = eng[slug];
        const h = health[slug];
        if (h && h.fresh) { h.note = `${h.note ? `${h.note} · ` : ""}engine: ${e.label}`; continue; }
        const issues = e.lastError ? [`last cloud job failed: ${e.lastError}`] : [];
        if (!e.up) issues.push(e.engine === "grokbot" ? "Grok Bot webhook not configured" : e.engine === "bridge" ? "Grok Bot bridge not configured" : "in-app runner not configured (ANTHROPIC_API_KEY / VAULT_GITHUB_TOKEN / SUPABASE_*)");
        const row: AgentHealth = { slug, dot: !e.up ? "offline" : issues.length ? "attention" : "healthy", machine: e.engine === "claude" ? "cloud · Agent Console" : "cloud · Grok Bot", reportedAt: e.lastJobAt || new Date().toISOString(), fresh: true, online: e.up, cronsActive: 0, cronsOk: 0, issues, note: e.lastJobAt ? `last cloud job ${e.lastStatus}` : "no cloud jobs yet" };
        health[slug] = row;
      }
    } catch { /* board still shows heartbeat rows */ }

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
