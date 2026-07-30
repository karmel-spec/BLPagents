import { readTab, writeTab } from "./sheets";

/**
 * Agent fleet health — heartbeat storage + status computation.
 *
 * Machines that run agents POST a heartbeat every ~10 minutes
 * (scripts/agent-heartbeat.mjs). One row per agent lands in the
 * "Agent Status" tab of the Leads Log. The Agents page reads the
 * computed health from /api/agents/health.
 */

export const STATUS_TAB = "Agent Status";
const HEADER = ["agent", "machine", "reported_at", "online", "crons_json", "note"];

/** Heartbeat considered fresh for this long (reporter fires every 10 min). */
const FRESH_MS = 45 * 60 * 1000;
/** An enabled cron whose next run is this far in the past has missed a run. */
const MISSED_MS = 30 * 60 * 1000;

export interface HeartbeatCron {
  name: string;
  enabled: boolean;
  schedule?: string;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  lastStatus?: string | null; // "ok" | "error" | null
  lastError?: string | null;
}

export interface HeartbeatAgent {
  slug: string;
  online?: boolean | null; // gateway/brain reachable on its machine (null = not applicable)
  note?: string;
  crons: HeartbeatCron[];
}

export interface HeartbeatPayload {
  machine: string;
  agents: HeartbeatAgent[];
}

export type HealthDot = "healthy" | "attention" | "offline" | "none";

export interface AgentHealth {
  slug: string;
  dot: HealthDot;
  machine: string;
  reportedAt: string;
  fresh: boolean;
  online: boolean | null;
  cronsActive: number;
  cronsOk: number;
  issues: string[];
  note?: string;
}

/** Upsert heartbeat rows (one per agent) into the status tab. */
export async function saveHeartbeat(payload: HeartbeatPayload): Promise<number> {
  const now = new Date().toISOString();
  const rows = await readTab(STATUS_TAB);
  // Keyed by slug+machine: the same agent can have workloads on several
  // machines (e.g. ivory: Hermes here, OpenClaw on Walter's Mac).
  const byAgent = new Map<string, string[]>();
  for (const r of rows.slice(1)) if (r[0]) byAgent.set(`${r[0]}|${r[1] || ""}`, r);

  for (const a of payload.agents) {
    if (!a.slug) continue;
    byAgent.set(`${a.slug}|${payload.machine || ""}`, [
      a.slug,
      payload.machine || "",
      now,
      a.online === true ? "TRUE" : a.online === false ? "FALSE" : "",
      JSON.stringify(a.crons || []),
      a.note || "",
    ]);
  }
  await writeTab(STATUS_TAB, [HEADER, ...[...byAgent.values()].sort((x, y) => x[0].localeCompare(y[0]))]);
  return payload.agents.length;
}

function cronIssues(crons: HeartbeatCron[], asOf: number): string[] {
  const issues: string[] = [];
  for (const c of crons) {
    if (!c.enabled) continue;
    if (c.lastStatus && c.lastStatus !== "ok") {
      issues.push(`cron "${c.name}" last run failed${c.lastError ? ` — ${String(c.lastError).slice(0, 120)}` : ""}`);
    }
    if (c.nextRunAt) {
      const next = Date.parse(c.nextRunAt);
      if (!Number.isNaN(next) && asOf - next > MISSED_MS) {
        issues.push(`cron "${c.name}" missed its scheduled run (${c.nextRunAt.slice(0, 16).replace("T", " ")})`);
      }
    }
  }
  return issues;
}

/** Compute per-agent health from the status tab. Keyed by slug. */
export async function readAgentHealth(): Promise<Record<string, AgentHealth>> {
  const rows = await readTab(STATUS_TAB);
  const out: Record<string, AgentHealth> = {};
  const now = Date.now();

  for (const r of rows.slice(1)) {
    const [slug, machine, reportedAt, online, cronsJson, note] = r;
    if (!slug) continue;
    let crons: HeartbeatCron[] = [];
    try {
      crons = JSON.parse(cronsJson || "[]");
    } catch {
      /* tolerate a hand-edited cell */
    }
    const reported = Date.parse(reportedAt || "");
    const fresh = !Number.isNaN(reported) && now - reported < FRESH_MS;
    const issues: string[] = [];
    const tag = machine ? `[${machine}] ` : "";
    if (!fresh) {
      issues.push(`${tag}no heartbeat since ${(reportedAt || "?").slice(0, 16).replace("T", " ")}`);
    } else {
      if (online === "FALSE") issues.push(`${tag}brain/gateway not responding`);
      issues.push(...cronIssues(crons, now).map((i) => tag + i));
      if (crons.length > 0 && !crons.some((c) => c.enabled)) {
        issues.push(`${tag}all ${crons.length} cron jobs are paused`);
      }
    }
    const active = crons.filter((c) => c.enabled);
    const piece: AgentHealth = {
      slug,
      machine: machine || "",
      reportedAt: reportedAt || "",
      fresh,
      online: online === "TRUE" ? true : online === "FALSE" ? false : null,
      cronsActive: active.length,
      cronsOk: active.filter((c) => !c.lastStatus || c.lastStatus === "ok").length,
      issues,
      note: note || undefined,
      dot: !fresh ? "offline" : issues.length ? "attention" : "healthy",
    };
    const prev = out[slug];
    if (!prev) {
      out[slug] = piece;
      continue;
    }
    // Merge multi-machine agents: any fresh heartbeat keeps them on the
    // board; issues accumulate with machine tags; counts sum.
    out[slug] = {
      ...prev,
      machine: [prev.machine, piece.machine].filter(Boolean).join(" + "),
      reportedAt: piece.reportedAt > prev.reportedAt ? piece.reportedAt : prev.reportedAt,
      fresh: prev.fresh || piece.fresh,
      online: prev.online === false || piece.online === false ? false : prev.online ?? piece.online,
      cronsActive: prev.cronsActive + piece.cronsActive,
      cronsOk: prev.cronsOk + piece.cronsOk,
      issues: [...prev.issues, ...piece.issues],
      dot:
        !(prev.fresh || piece.fresh) ? "offline"
        : prev.issues.length + piece.issues.length > 0 ? "attention"
        : "healthy",
    };
  }
  return out;
}
