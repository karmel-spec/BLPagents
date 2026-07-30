"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/client";
import { AGENTS, type AgentConfig } from "@/lib/agents";
import { Avatar, DOT_LABEL, DOT_RANK, ago, dotClass, type HealthDot, type HealthMap } from "./fleet-shared";

/** Mission Control — the fleet board. */

type Event = { at: string; text: string };

function Board() {
  const router = useRouter();
  const dept = useSearchParams().get("dept");
  const [health, setHealth] = useState<HealthMap | null>(null);
  const [error, setError] = useState("");
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ health: HealthMap }>("/api/agents/health")
        .then((r) => {
          if (!alive) return;
          setHealth(r.health);
          setError("");
          setCheckedAt(new Date());
        })
        .catch((e) => alive && setError(e.message));
    load();
    const timer = setInterval(load, 5 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const dotFor = (a: AgentConfig): HealthDot => health?.[a.slug]?.dot ?? "none";

  const agents = useMemo(() => {
    const list = dept ? AGENTS.filter((a) => a.department === dept) : [...AGENTS];
    return list.sort((x, y) => DOT_RANK[dotFor(x)] - DOT_RANK[dotFor(y)] || x.name.localeCompare(y.name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dept, health]);

  const counts = { healthy: 0, attention: 0, offline: 0, none: 0 };
  for (const a of AGENTS) counts[dotFor(a)]++;
  const machines = new Set(
    Object.values(health || {}).flatMap((h) => h.machine.split(" + ").filter(Boolean))
  );

  const events: Event[] = useMemo(() => {
    if (!health) return [];
    const out: Event[] = [];
    for (const h of Object.values(health)) {
      const agent = AGENTS.find((a) => a.slug === h.slug);
      const name = agent?.name || h.slug;
      for (const issue of h.issues) out.push({ at: h.reportedAt, text: `${name}: ${issue}` });
      if (h.fresh && h.issues.length === 0) {
        out.push({
          at: h.reportedAt,
          text: `${name} reported healthy — ${h.cronsOk}/${h.cronsActive} crons ok on ${h.machine}`,
        });
      }
    }
    return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 14);
  }, [health]);

  return (
    <>
      <div className="page-head">
        <h1>Fleet{dept ? ` — ${dept}` : ""}</h1>
        <span className="clock">
          {checkedAt
            ? `last sweep ${checkedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
            : "checking heartbeats…"}
        </span>
      </div>

      <div className="strip">
        <span className="chip"><span className="dot h" />{health ? counts.healthy : "…"} healthy</span>
        <span className="chip"><span className="dot w" />{health ? counts.attention : "…"} need attention</span>
        <span className="chip"><span className="dot o" />{health ? counts.offline : "…"} offline</span>
        <span className="chip"><span className="dot n" />{health ? counts.none : "…"} on deck</span>
        {machines.size > 0 && <span className="chip">{machines.size} machine{machines.size === 1 ? "" : "s"} reporting</span>}
      </div>

      {error && <div className="banner bad">⚠ {error}</div>}

      <div className="board">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 18 }}></th>
                <th>Agent</th>
                <th>Machine</th>
                <th>Crons</th>
                <th>Heartbeat</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => {
                const h = health?.[a.slug];
                const d = dotFor(a);
                return (
                  <tr
                    key={a.slug}
                    className={`rowlink${d === "attention" ? " warn" : d === "offline" ? " off" : ""}`}
                    onClick={() => router.push(`/agents/${a.slug}`)}
                  >
                    <td><span className={`dot ${dotClass(d)}`} title={DOT_LABEL[d]} /></td>
                    <td>
                      <span className="ag">
                        <Avatar agent={a} size={28} live={d !== "none"} />
                        <span>
                          {a.name}
                          <span className="r">{a.role}</span>
                        </span>
                      </span>
                      {h && h.issues.length > 0 && (
                        <ul className="issues">
                          {h.issues.map((issue, i) => (
                            <li key={i}>{issue}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                    <td className="mono">{h?.machine || "—"}</td>
                    <td className="mono">{h && h.cronsActive > 0 ? `${h.cronsOk}/${h.cronsActive}` : "—"}</td>
                    <td className="mono">{h ? ago(h.reportedAt) : a.registryStatus === "Active" ? "active" : "on deck"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="feed">
          <h2>Activity</h2>
          {!health && !error && <div className="ev muted">listening for heartbeats…</div>}
          {health && events.length === 0 && <div className="ev muted">No heartbeats in the status tab yet.</div>}
          {events.map((e, i) => (
            <div key={i} className="ev">
              <span className="t">{ago(e.at)} ago</span>
              {e.text}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

export default function FleetPage() {
  return (
    <Suspense fallback={<div className="muted">Loading fleet…</div>}>
      <Board />
    </Suspense>
  );
}
