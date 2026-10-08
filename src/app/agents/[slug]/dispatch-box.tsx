"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import type { AgentConfig } from "@/lib/agents";
import type { DispatchReceipt, DispatchRecord, RunStatus } from "@/lib/gateway";
import { findGrokbotReply, GROKBOT_POLL_MS, GROKBOT_REPLY_TIMEOUT_MS, IVORY_MOVING_NOTICE, IVORY_TIMEOUT_NOTICE } from "@/lib/grokbot-shared";
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

  const onGrokBot = /grok bot/i.test(agent.runtime || "");
  const viaGrokbot = agent.provider === "grokbot";

  useEffect(() => {
    if (onGrokBot || viaGrokbot) return;
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
  }, [agent.slug, onGrokBot, viaGrokbot]);

  // Ivory's tasks go to Ivory Grok Bot (same thread as chat), never Hermes.
  if (viaGrokbot) return <GrokbotDispatch agent={agent} />;
  // Eddy Bot answers on Grok Bot. Do not hand his tasks to a Hermes profile.
  if (onGrokBot) return null;

  if (liveError) return <div className="banner bad">⚠ Agent gateway: {liveError}</div>;
  if (!live) return null;
  if (!live.configured) return null; // gateway not set up on this deployment — nothing to show
  const up = Boolean(live.agents[agent.slug]?.up);
  if (!up) {
    return (
      <div className="card">
        <h2>Give {agent.name} a task</h2>
        <div className="muted" style={{ fontSize: 13 }}>
          {agent.name} isn&apos;t running on {live.machine || "the agents' Mac"} right now, so tasks can&apos;t be dispatched. Running agents show a green dot on the Agents board.
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

type GrokDispatch = {
  at: string;
  requester: string;
  input: string;
  run_id: string;
  status: string;
  output: string | null;
};

/** Dispatch box for Ivory: store the task, wake Ivory Grok Bot, wait for her row in the thread. */
function GrokbotDispatch({ agent }: { agent: AgentConfig }) {
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [output, setOutput] = useState("");
  const [recent, setRecent] = useState<GrokDispatch[]>([]);
  const alive = useRef(true);

  const loadRecent = () =>
    api<{ dispatches: GrokDispatch[]; notice?: string }>(`/api/agents/${agent.slug}/dispatch`)
      .then((r) => { setRecent(r.dispatches || []); if (r.notice) setNotice(r.notice); })
      .catch((e) => setError(e.message));

  useEffect(() => {
    alive.current = true;
    loadRecent();
    return () => { alive.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.slug]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const input = task.trim();
    if (!input || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    setOutput("");
    try {
      const delivered = await api<{ provider?: string; status?: string; messageId?: number; notice?: string }>(`/api/agents/${agent.slug}/dispatch`, {
        method: "POST",
        body: JSON.stringify({ input }),
      });
      if (delivered.status === "moving") {
        setNotice(delivered.notice || IVORY_MOVING_NOTICE);
        setBusy(false);
        return;
      }
      setTask("");
      const messageId = delivered.messageId;
      if (!messageId) throw new Error(`${agent.name} didn't take that task.`);
      const t0 = Date.now();
      let landed = false;
      for (;;) {
        if (!alive.current) return;
        try {
          const h = await api<{ messages: { id?: number; role: string; body: string; run_id?: string | null; reply_to?: number | null; meta?: { in_reply_to?: number | null } | null }[] }>(`/api/agents/${agent.slug}/chat?limit=80`);
          const reply = findGrokbotReply(h.messages, messageId);
          if (reply?.body) { setOutput(reply.body); landed = true; break; }
        } catch { /* keep waiting through a blip */ }
        if (Date.now() - t0 >= GROKBOT_REPLY_TIMEOUT_MS) break;
        await new Promise((r) => setTimeout(r, GROKBOT_POLL_MS));
      }
      if (!landed) setNotice(IVORY_TIMEOUT_NOTICE);
      loadRecent();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

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
            disabled={busy}
          />
          <div className="dispatch-actions">
            <button className="btn" disabled={busy || !task.trim()}>
              {busy ? `${agent.name} is working on it…` : `Send to ${agent.name}`}
            </button>
            <span className="muted" style={{ fontSize: 11.5 }}>
              Ivory Grok Bot, in the cloud · the reply lands in her chat thread
            </span>
          </div>
        </form>
        <aside className="dispatch-rules">
          <div className="label">{agent.name} will never</div>
          <p>{agent.boundaries.never}</p>
          {agent.boundaries.voice && (<><div className="label" style={{ marginTop: 8 }}>Voice</div><p>{agent.boundaries.voice}</p></>)}
        </aside>
      </div>
      {notice && <div className="banner warn">{notice}</div>}
      {error && <div className="banner bad">⚠ {error}</div>}
      {busy && <div className="muted" style={{ marginTop: 8 }}>{agent.name} is working on it…</div>}
      {output && <pre className="run-output">{output}</pre>}
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
    case "carla": return "Which vehicles have maintenance or registration due in the next 30 days?";
    case "chris": return "What is the state of the shop this morning — queue, stalled pianos, missing stages, and what is waiting on me?";
    default: return "Describe the task in a sentence or two.";
  }
}
