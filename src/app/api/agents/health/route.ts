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

    // Cloud health (Brigham, 2026-10-14: no Hermes). For every agent with a cloud
    // engine the dot comes from the console's own records — engine configured,
    // last job outcome, anything stuck, silence — never from a Mac heartbeat.
    // Agents without an engine keep whatever the status tab says (historic).
    try {
      const slugs = AGENTS.filter((a) => chatEnabled(a.slug)).map((a) => a.slug);
      const eng = await engineStatus(slugs, brainConfigured());
      const waitMs = (Number(process.env.GROKBOT_WAIT_MINUTES) || 10) * 60_000;
      for (const slug of slugs) {
        const e = eng[slug];
        const issues: string[] = [];
        if (!e.up) issues.push(e.engine === "grokbot" ? "Grok Bot webhook not configured on this deployment" : e.engine === "bridge" ? "Grok Bot bridge not configured on this deployment" : "in-app runner not configured (ANTHROPIC_API_KEY / VAULT_GITHUB_TOKEN / SUPABASE_*)");
        if (e.lastStatus === "failed") issues.push(`last cloud job failed: ${e.lastError || ""}`.trim());
        if (e.lastJobAt && Date.now() - Date.parse(e.lastJobAt) > 7 * 24 * 3600_000) issues.push(`no cloud job in 7 days (last ${e.lastJobAt.slice(0, 10)}) — silent is not healthy`);
        if (e.open > 0 && e.lastJobAt && Date.now() - Date.parse(e.lastJobAt) > waitMs) issues.push(`${e.open} job(s) still open longer than ${Math.round(waitMs / 60000)} min`);
        health[slug] = {
          slug,
          dot: !e.up ? "offline" : issues.length ? "attention" : "healthy",
          machine: e.engine === "claude" ? "cloud · Agent Console" : "cloud · Grok Bot",
          reportedAt: e.lastJobAt || "",
          fresh: true,
          online: e.up,
          cronsActive: 0,
          cronsOk: 0,
          issues,
          note: `${e.label}${e.lastJobAt ? ` · last cloud job ${e.lastStatus}` : " · no cloud jobs yet"}${e.open ? ` · ${e.open} working` : ""}`,
        } as AgentHealth;
      }
    } catch { /* board still shows status-tab rows */ }

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
