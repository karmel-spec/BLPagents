"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/client";
import { getAgent } from "@/lib/agents";
import { Avatar, ago } from "../fleet-shared";
import type { ActivityEvent } from "@/lib/activity";
import type { Briefing } from "@/lib/briefings";

/** Activity tracker — today's briefings first, then what the fleet has been doing. */

type Filter = "all" | "problems" | "crons";

function postedAt(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Denver" });
}

/** One card per owning agent; a split brief (admin) renders one card per owner. */
function BriefCard({ brief, agentSlug }: { brief: Briefing; agentSlug: string }) {
  const agent = getAgent(agentSlug);
  const doc = brief.doc;
  const mine = brief.sections.filter((s) => s.owner === agentSlug);
  const shared = brief.sections.filter((s) => s.owner === "shared");
  const split = brief.agents.length > 1;
  const state = !doc ? "missing" : doc.isToday ? "today" : "stale";

  return (
    <div className={`brief ${state}`}>
      <div className="brief-head">
        {agent ? (
          <Link href={`/agents/${agent.slug}`} className="ag">
            <Avatar agent={agent} size={34} live={state === "today"} />
            <span>
              {agent.name}
              <span className="r">{agent.role}</span>
            </span>
          </Link>
        ) : (
          <span className="ag">{agentSlug}</span>
        )}
        <span className={`dot ${state === "today" ? "h" : state === "stale" ? "w" : "n"}`} title={state} />
      </div>
      <div className="brief-title">{brief.title}{split ? ` — ${agent?.name}'s sections` : ""}</div>
      {doc ? (
        <>
          <div className="brief-meta">
            {doc.isToday ? `Posted ${postedAt(doc.modifiedAt)}` : `Last posted ${ago(doc.modifiedAt)} ago`}
            {doc.toReview !== null && ` · ${doc.toReview} to review`}
          </div>
          {split && mine.length > 0 && (
            <ul className="brief-sections">
              {mine.map((s) => (
                <li key={s.title}><a href={s.href} target="_blank" rel="noreferrer">{s.title}</a></li>
              ))}
              {shared.map((s) => (
                <li key={s.title} className="muted"><a href={s.href} target="_blank" rel="noreferrer">{s.title}</a> · shared</li>
              ))}
            </ul>
          )}
          <a className="btn ghost small" href={doc.href} target="_blank" rel="noreferrer">Open brief ↗</a>
        </>
      ) : (
        <div className="brief-meta muted">Not posted yet · runs {brief.schedule}</div>
      )}
    </div>
  );
}

export default function ActivityPage() {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [briefs, setBriefs] = useState<Briefing[] | null>(null);
  const [folderHref, setFolderHref] = useState("");
  const [error, setError] = useState("");
  const [briefError, setBriefError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  useEffect(() => {
    api<{ events: ActivityEvent[] }>("/api/agents/activity")
      .then((r) => setEvents(r.events))
      .catch((e) => setError(e.message));
    api<{ briefings: Briefing[]; folderHref: string }>("/api/briefings")
      .then((r) => {
        setBriefs(r.briefings);
        setFolderHref(r.folderHref);
      })
      .catch((e) => setBriefError(e.message));
  }, []);

  const shown = useMemo(() => {
    if (!events) return [];
    if (filter === "problems") return events.filter((e) => e.kind === "cron_error");
    if (filter === "crons") return events.filter((e) => e.kind !== "heartbeat");
    return events;
  }, [events, filter]);

  const posted = briefs?.filter((b) => b.doc?.isToday).length ?? 0;
  const cards = briefs?.flatMap((b) => b.agents.map((slug) => ({ brief: b, slug }))) ?? [];

  return (
    <>
      <div className="page-head">
        <h1>Daily Briefings</h1>
        <span className="clock">
          {briefs ? `${posted} of ${briefs.length} posted today` : "checking the Briefs folder…"}
          {folderHref && <> · <a href={folderHref} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>Drive folder ↗</a></>}
        </span>
      </div>

      {briefError && <div className="banner bad">⚠ {briefError}</div>}
      <div className="brief-grid">
        {cards.map(({ brief, slug }) => (
          <BriefCard key={`${brief.key}-${slug}`} brief={brief} agentSlug={slug} />
        ))}
      </div>

      <div className="page-head" style={{ marginTop: 28 }}>
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
