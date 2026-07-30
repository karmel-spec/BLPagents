import { readTab } from "./sheets";
import { STATUS_TAB, type HeartbeatCron } from "./agent-health";

/**
 * Activity stream — derived from the same "Agent Status" tab as fleet
 * health. Each heartbeat row carries every cron's last run + status, so the
 * fleet's recent work reconstructs without any extra logging pipeline.
 */

export type ActivityKind = "cron_ok" | "cron_error" | "heartbeat";

export interface ActivityEvent {
  at: string; // ISO timestamp
  kind: ActivityKind;
  slug: string;
  machine: string;
  text: string;
}

export async function readAgentActivity(limit = 120): Promise<ActivityEvent[]> {
  const rows = await readTab(STATUS_TAB);
  const events: ActivityEvent[] = [];

  for (const r of rows.slice(1)) {
    const [slug, machine, reportedAt, , cronsJson] = r;
    if (!slug) continue;
    let crons: HeartbeatCron[] = [];
    try {
      crons = JSON.parse(cronsJson || "[]");
    } catch {
      /* tolerate a hand-edited cell */
    }

    if (reportedAt) {
      events.push({
        at: reportedAt,
        kind: "heartbeat",
        slug,
        machine: machine || "",
        text: `heartbeat from ${machine || "unknown machine"}`,
      });
    }

    for (const c of crons) {
      if (!c.lastRunAt) continue;
      const failed = Boolean(c.lastStatus && c.lastStatus !== "ok");
      events.push({
        at: c.lastRunAt,
        kind: failed ? "cron_error" : "cron_ok",
        slug,
        machine: machine || "",
        text: failed
          ? `cron “${c.name}” failed${c.lastError ? ` — ${String(c.lastError).slice(0, 160)}` : ""}`
          : `cron “${c.name}” ran`,
      });
    }
  }

  return events
    .filter((e) => !Number.isNaN(Date.parse(e.at)))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit);
}
