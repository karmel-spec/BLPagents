"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import type { AgentConfig } from "@/lib/agents";
import type { DispatchReceipt, DispatchRecord, RunStatus } from "@/lib/gateway";
import { ago } from "../../fleet-shared";

/**
 * Dispatch box — hand a live agent one task from the console. The task goes
 * console → gateway (Karmel's Mac, via tunnel) → the agent's Hermes runtime;
 * we poll for the result and show it here. Boundaries sit beside the box so
 * whoever is typing sees what the agent will never do.
 */

type Live = { configured: boolean; machine?: string; agents: Record<string, { up: boolean }> };

export default function DispatchBox({ agent }: { agent: AgentConfig }) {
  const [live, setLive] = useState<Live | null>(null);
  const [liveError, setLiveError] = useState("");
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [run, setRun] = useState<(RunStatus & { startedAt: number }) | null>(null);
  const [recent, setRecent] = useState<DispatchRecord[]>([]);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadRecent = () =>
    api<{ dispatches: DispatchRecord[] }>(`/api/agents/${agent.slug}/dispatch`)
      .then((r) => setRecent(r.dispatches))
      .catch(() => {});

  useEffect(() => {
    api<Live>("/api/agents/live")
      .then((l) => {
        setLive(l);
        if (l.configured && l.agents[agent.slug]?.up) loadRecent();
      })
      .catch((e) => setLiveError(e.message));
    return () => {
      if (poll.current) clearInterval(poll.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.slug]);

  if (liveError) return <div className="banner bad">⚠ Agent gateway: {liveError}</div>;
  if (!live) return null;
  if (!live.configured) return null; // gateway not set up on this deployment — nothing to show
  const up = Boolean(live.agents[agent.slug]?.up);
  if (!up) {
    return (
      <div className="card">
        <h2>Give {agent.name} a task</h2>
        <div className="muted" style={{ fontSize: 13 }}>
          {agent.name} isn&apos;t running on {live.machine || "the agents' Mac"} right now, so tasks can&apos;t be dispatched. Live agents show a green dot on the Fleet board.
        </div>
      </div>
    );
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setRun(null);
    try {
      const receipt = await api<DispatchReceipt>(`/api/agents/${agent.slug}/dispatch`, {
        method: "POST",
        body: JSON.stringify({ input: task }),
      });
      setRun({ slug: agent.slug, run_id: receipt.run_id, status: receipt.status, output: null, usage: null, startedAt: Date.now() });
      setTask("");
      loadRecent();
      if (poll.current) clearInterval(poll.current);
      poll.current = setInterval(async () => {
        try {
          const s = await api<RunStatus>(`/api/agents/${agent.slug}/runs/${receipt.run_id}`);
          setRun((r) => (r ? { ...r, ...s } : r));
          if (s.status === "completed" || s.status === "failed") {
            if (poll.current) clearInterval(poll.current);
            loadRecent();
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          if (poll.current) clearInterval(poll.current);
        }
      }, 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const working = run && run.status !== "completed" && run.status !== "failed";

  return (
    <div className="card dispatch">
      <h2>Give {agent.name} a task</h2>
      <div className="dispatch-grid">
        <form onSubmit={send}>
          <textarea
            rows={4}
            placeholder={`e.g. ${placeholderFor(agent)}`}
            value={task}
            onChange={(e) => setTask(e.target.value)}
            disabled={busy || Boolean(working)}
          />
          <div className="dispatch-actions">
            <button className="btn" disabled={busy || Boolean(working) || !task.trim()}>
              {busy ? "Sending…" : working ? `${agent.name} is working…` : `Send to ${agent.name}`}
            </button>
            <span className="muted" style={{ fontSize: 11.5 }}>
              Runs on {live.machine?.split(".")[0] || "the agents' Mac"} · every task is logged with who sent it
            </span>
          </div>
        </form>
        <aside className="dispatch-rules">
          <div className="label">{agent.name} will never</div>
          <p>{agent.boundaries.never}</p>
          {agent.boundaries.voice && (<><div className="label" style={{ marginTop: 8 }}>Voice</div><p>{agent.boundaries.voice}</p></>)}
        </aside>
      </div>

      {error && <div className="banner bad">⚠ {error}</div>}

      {run && (
        <div className={`run ${run.status}`}>
          <div className="run-head">
            <span className={`dot ${run.status === "completed" ? "h" : run.status === "failed" ? "o" : "w"}`} />
            <span className="mono">run {run.run_id.slice(4, 12)}</span>
            <span className="muted">
              {run.status === "completed" ? `done in ${Math.round((Date.now() - run.startedAt) / 1000)}s` : run.status === "failed" ? "failed" : `${run.status}…`}
            </span>
          </div>
          {run.output && <pre className="run-output">{run.output}</pre>}
        </div>
      )}

      {recent.length > 0 && (
        <div className="recent">
          <div className="label">Recent tasks</div>
          {recent.map((d) => (
            <div key={d.run_id} className="recent-row">
              <span className="mono">{ago(d.at)} ago</span>
              <span className="who">{d.requester.replace(/<.*>/, "").trim()}</span>
              <span className="what">{d.input.length > 120 ? d.input.slice(0, 120) + "…" : d.input}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function placeholderFor(agent: AgentConfig): string {
  switch (agent.slug) {
    case "arnold": return "Review the five hottest restoration leads and draft follow-ups for any without a fresh draft.";
    case "ivory": return "List tomorrow's tuning appointments and draft confirmation texts for each.";
    case "melody": return "Triage info@ from the last 24 hours and draft replies for anything asking about pricing or scheduling.";
    case "marcus": return "Draft three Instagram captions for this week's Hailun arrivals — [DRAFT] to Gmail, don't publish.";
    case "lindsay": return "What did every agent do in the last 24 hours, and what failed?";
    case "clara": return "What's on Brigham's calendar tomorrow, and what does each meeting need?";
    default: return "Describe the task in a sentence or two.";
  }
}
