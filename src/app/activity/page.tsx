"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/client";
import { getAgent } from "@/lib/agents";
import { Avatar, ago } from "../fleet-shared";
import type { ActivityEvent } from "@/lib/activity";

/** Activity tracker — what the fleet has actually been doing, newest first. */

type Filter = "all" | "problems" | "crons";

export default function ActivityPage() {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    api<{ events: ActivityEvent[] }>("/api/agents/activity")
      .then((r) => setEvents(r.events))
      .catch((e) => setError(e.message));
  }, []);

  const shown = useMemo(() => {
    if (!events) return [];
    if (filter === "problems") return events.filter((e) => e.kind === "cron_error");
    if (filter === "crons") return events.filter((e) => e.kind !== "heartbeat");
    return events;
  }, [events, filter]);

  return (
    <>
      <div className="page-head">
        <h1>Activity</h1>
        <span className="clock">cron runs &amp; heartbeats, newest first</span>
      </div>

      <div className="strip">
        {(
          [
            ["all", "Everything"],
            ["crons", "Cron runs"],
            ["problems", "Problems only"],
          ] as [Filter, string][]
        ).map(([f, label]) => (
          <button
            key={f}
            className={`chip filterbtn${filter === f ? " on" : ""}`}
            onClick={() => setFilter(f)}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <div className="banner bad">⚠ {error}</div>}
      {!events && !error && <div className="muted">Reading the status tab…</div>}
      {events && shown.length === 0 && <div className="banner">Nothing here yet.</div>}

      <div className="table-wrap" style={{ maxWidth: 760 }}>
        <table>
          <tbody>
            {shown.map((e, i) => {
              const agent = getAgent(e.slug);
              return (
                <tr key={i} className={e.kind === "cron_error" ? "off" : ""}>
                  <td style={{ width: 18 }}>
                    <span className={`dot ${e.kind === "cron_error" ? "o" : e.kind === "cron_ok" ? "h" : "n"}`} />
                  </td>
                  <td style={{ width: 200 }}>
                    {agent ? (
                      <Link href={`/agents/${agent.slug}`} className="ag">
                        <Avatar agent={agent} size={24} live />
                        <span>{agent.name}</span>
                      </Link>
                    ) : (
                      <span className="ag">{e.slug}</span>
                    )}
                  </td>
                  <td>{e.text}</td>
                  <td className="mono" style={{ whiteSpace: "nowrap" }}>{ago(e.at)} ago</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
