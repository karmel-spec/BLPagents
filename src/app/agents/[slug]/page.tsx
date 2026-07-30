"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/client";
import { getAgent } from "@/lib/agents";
import { Avatar, DOT_LABEL, ago, dotClass, type HealthMap } from "../../fleet-shared";

/**
 * Agent console — renders any agent from the registry with live health
 * from the heartbeat tab plus vault-harvested mission/boundaries.
 */
export default function AgentConsole({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const agent = getAgent(slug);
  const [health, setHealth] = useState<HealthMap | null>(null);

  useEffect(() => {
    api<{ health: HealthMap }>("/api/agents/health").then((r) => setHealth(r.health)).catch(() => {});
  }, []);

  if (!agent) {
    return (
      <div className="banner bad">
        ⚠ No agent named “{slug}” in the registry. <Link href="/" style={{ textDecoration: "underline" }}>Back to the fleet</Link>
      </div>
    );
  }

  const h = health?.[agent.slug];
  const d = h?.dot ?? "none";

  return (
    <>
      <div className="page-head" style={{ alignItems: "center", gap: 16 }}>
        <Link href="/" className="crumb">← Fleet</Link>
        <Avatar agent={agent} size={56} live={d !== "none" || agent.status === "live"} />
        <div>
          <h1 style={{ marginBottom: 2 }}>{agent.name}</h1>
          <div className="muted" style={{ fontSize: 13 }}>
            {agent.role} · {agent.department} · reports to {agent.reportsTo}
          </div>
        </div>
        <span style={{ flex: 1 }} />
        {agent.telegram && agent.telegramActive && (
          <a className="btn" href={agent.telegram} target="_blank" rel="noreferrer">
            Message {agent.name}
          </a>
        )}
      </div>

      <div className="strip" style={{ marginTop: 14 }}>
        <span className="chip"><span className={`dot ${dotClass(d)}`} />{DOT_LABEL[d]}</span>
        {h && <span className="chip">machine: {h.machine || "—"}</span>}
        {h && h.cronsActive > 0 && <span className="chip">{h.cronsOk}/{h.cronsActive} crons ok</span>}
        {h && <span className="chip">heartbeat {ago(h.reportedAt)} ago</span>}
        {!h && <span className="chip">{agent.registryStatus || "On Deck"} — no heartbeats yet</span>}
      </div>

      {h && h.issues.length > 0 && (
        <div className={`banner ${d === "offline" ? "bad" : "warn"}`}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {h.issues.map((issue, i) => (
              <li key={i}>{issue}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="banner info">{agent.tagline}</div>

      {agent.status === "coming-soon" && !h && (
        <div className="banner warn">
          🚧 {agent.name} isn&apos;t wired up yet
          {agent.vault
            ? " — the info below comes from the Knowledge Vault; live health arrives with the first heartbeat."
            : ` — this page is the template we'll fill in when ${agent.name} goes live.`}
        </div>
      )}

      <div className="two-col" style={{ marginTop: 16 }}>
        <div>
          {agent.vault?.mission && (
            <div className="card">
              <h2>Mission</h2>
              <p style={{ margin: 0 }}>{agent.vault.mission}</p>
            </div>
          )}

          {(agent.vault?.currentProjects?.length || 0) > 0 && (
            <div className="card">
              <h2>Current projects</h2>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {agent.vault!.currentProjects!.map((p, i) => (
                  <li key={i} style={{ marginBottom: 6 }}>{p}</li>
                ))}
              </ul>
              {(agent.vault?.openQuestions?.length || 0) > 0 && (
                <>
                  <div className="label" style={{ marginTop: 12 }}>Open questions</div>
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18 }} className="muted">
                    {agent.vault!.openQuestions!.map((q, i) => (
                      <li key={i} style={{ marginBottom: 4 }}>{q}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          <div className="card">
            <h2>Schedule</h2>
            {agent.schedule.length === 0 && (agent.vault?.requestedCrons?.length || 0) === 0 && (
              <div className="muted">No schedule yet.</div>
            )}
            {agent.schedule.map((s, i) => (
              <div key={i} style={{ padding: "7px 0", borderBottom: "1px solid var(--line-soft)" }}>
                <strong>{s.time}</strong> <span className="muted">{s.days}</span>
                <div>{s.what}{s.where && <span className="muted"> → {s.where}</span>}</div>
              </div>
            ))}
            {(agent.vault?.requestedCrons?.length || 0) > 0 && (
              <>
                <div className="label" style={{ marginTop: agent.schedule.length ? 12 : 0 }}>
                  Requested (not yet running)
                </div>
                <ul style={{ margin: "6px 0 0", paddingLeft: 18 }} className="muted">
                  {agent.vault!.requestedCrons!.map((c, i) => (
                    <li key={i} style={{ marginBottom: 4 }}>{c}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>

        <div>
          <div className="card">
            <h2>Registry</h2>
            <dl className="kv">
              <dt>Status</dt>
              <dd>{agent.status === "live" ? "Live" : agent.registryStatus || "On Deck"}</dd>
              {agent.runtime && (<><dt>Runtime</dt><dd>{agent.runtime}</dd></>)}
              {agent.homeComputer && (<><dt>Home computer</dt><dd>{agent.homeComputer}</dd></>)}
              {agent.email && (<><dt>Email</dt><dd>{agent.email}</dd></>)}
              {agent.crons && (<><dt>Registry crons</dt><dd>{agent.crons}</dd></>)}
            </dl>
          </div>

          <div className="card">
            <h2>Boundaries</h2>
            <dl className="kv">
              <dt>Can do</dt>
              <dd>{agent.boundaries.can}</dd>
              <dt>Never</dt>
              <dd>{agent.boundaries.never}</dd>
              {agent.boundaries.voice && (<><dt>Voice</dt><dd>{agent.boundaries.voice}</dd></>)}
            </dl>
          </div>

          {agent.links.length > 0 && (
            <div className="card">
              <h2>Links</h2>
              {agent.links.map((r) => (
                <div key={r.name} style={{ padding: "7px 0", borderBottom: "1px solid var(--line-soft)" }}>
                  <a href={r.href} target={r.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer" style={{ textDecoration: "underline" }}>
                    {r.name}
                  </a>
                  {r.note && <div className="muted" style={{ fontSize: 12 }}>{r.note}</div>}
                </div>
              ))}
            </div>
          )}

          {(agent.mindLinks?.length || agent.onMacFiles.length > 0) && (
            <div className="card">
              <h2>Mind &amp; memory</h2>
              {agent.mindLinks?.map((m) => (
                <div key={m.name} style={{ padding: "7px 0", borderBottom: "1px solid var(--line-soft)" }}>
                  <a href={m.href} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>{m.name} ↗</a>
                  {m.note && <div className="muted" style={{ fontSize: 12 }}>{m.note}</div>}
                </div>
              ))}
              {agent.onMacFiles.length > 0 && (
                <div className="muted" style={{ margin: "8px 0", fontSize: 12 }}>
                  Local copies live on the machine that runs this agent&apos;s brain:
                </div>
              )}
              {agent.onMacFiles.map(([name, path]) => (
                <div key={name} style={{ padding: "6px 0" }}>
                  <strong style={{ fontSize: 12.5 }}>{name}</strong>
                  <div className="mono" style={{ overflowWrap: "anywhere" }}>{path}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
