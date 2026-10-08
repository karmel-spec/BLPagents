"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import type { AgentConfig } from "@/lib/agents";

/**
 * In-app chat with an agent — the agent's own mind (vault files) + the Claude
 * API, no Hermes. One thread per agent, shared across the apps (same rows the
 * Store Map chat shows). Used on the agent page and full-height in the popup.
 */
type Msg = { id?: number; role: "user" | "agent"; who?: string; body: string; created_at?: string; meta?: { tools?: string[]; conversation_id?: string } | null };

const stamp = (iso?: string) => (iso ? new Date(iso) : new Date()).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const QUICK: Record<string, string[]> = {
  lindsay: ["What's open on Karmel's asks list right now?", "Look up this customer in QuickBooks and tell me what they still owe.", "Which agents are live and which are waiting on something?"],
  clara: ["What's on Brigham's plate this week according to your sources?", "Which inbox cleanup rules are approved and which are still proposals?", "Suggest three customer engagement ideas for this month."],
  chris: [
    "What's at the front of the shop queue and what's it waiting on?",
    "Which pianos are stuck in a phase longer than the time standard?",
    "Which pianos are missing a before video?",
    "Turn this note from Brigham into a task card — I'll paste it next.",
  ],
  marcus: ["Which for-sale pianos deserve a post this week and why?", "Write a KSL listing for the piano I name next.", "What does our brand voice guide say about pricing in posts?"],
  ivory: ["What's open on your TODO list right now?", "Walk me through the scheduling and intake playbook in five lines.", "Look up the customer I name next."],
  arnold: [
    "What should Brigham's top three follow-ups be right now?",
    "Which leads reached out and are still waiting on us?",
    "Draft a check-in text for the lead I name next.",
    "What did Brigham coach you on most recently?",
  ],
};

/** Just enough markdown for chat: **bold**, `code`, and list bullets. Everything else stays as typed. */
function renderLite(text: string) {
  return text.split("\n").map((line, i) => {
    const bullet = /^\s*[-•*]\s+/.test(line);
    const parts = line.replace(/^\s*[-•*]\s+/, "").split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((p, j) =>
      p.startsWith("**") ? <b key={j}>{p.slice(2, -2)}</b> : p.startsWith("`") ? <code key={j}>{p.slice(1, -1)}</code> : p
    );
    return <div key={i} style={bullet ? { paddingLeft: 14, textIndent: -10 } : undefined}>{bullet ? "• " : ""}{parts}{line === "" ? "\u00a0" : ""}</div>;
  });
}

/** Keep an optimistic row only until the server copy of that same send arrives. */
function mergeThread(prev: Msg[], server: Msg[]): Msg[] {
  const kept = prev.filter((o) => o.id == null && !server.some((s) => s.role === o.role && s.body === o.body && Math.abs(Date.parse(s.created_at || "") - Date.parse(o.created_at || "")) < 60_000));
  return [...server, ...kept];
}
function hostApp(): string {
  if (typeof window === "undefined") return "Agent Console";
  const q = new URLSearchParams(window.location.search).get("app");
  if (q && q.trim()) return q.trim().slice(0, 120);
  if (window.location.pathname.endsWith("/chat")) return "Agent Console chat";
  return "Agent Console";
}

export default function ChatPanel({ agent, compact = false }: { agent: AgentConfig; compact?: boolean }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [bridgeWait, setBridgeWait] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [bridged, setBridged] = useState(false);
  const [state, setState] = useState<"loading" | "off" | "unconfigured" | "ready">("loading");
  const end = useRef<HTMLDivElement>(null);
  const waitFrom = useRef("");
  const limit = compact ? 60 : 120;

  useEffect(() => {
    api<{ enabled: boolean; configured?: boolean; bridged?: boolean; messages: Msg[]; error?: string }>(`/api/agents/${agent.slug}/chat?limit=${limit}`)
      .then((r) => { if (!r.enabled) setState("off"); else if (r.configured === false) { setState("unconfigured"); setError(r.error || ""); } else { setState("ready"); setBridged(Boolean(r.bridged)); setMsgs(r.messages); } })
      .catch((e) => { setState("unconfigured"); setError(e.message); });
  }, [agent.slug, limit]);
  // Cristofori's reply can land a minute later. Poll the thread while this chat is open.
  useEffect(() => {
    if (state !== "ready" || !bridged) return;
    let stop = false;
    const t = setInterval(() => {
      api<{ messages: Msg[] }>(`/api/agents/${agent.slug}/chat?limit=${limit}`)
        .then((r) => {
          if (stop || !r.messages) return;
          setMsgs((prev) => mergeThread(prev, r.messages));
          if (waitFrom.current && r.messages.some((m) => m.role === "agent" && Date.parse(m.created_at || "") >= Date.parse(waitFrom.current) - 15_000)) setNote("");
        })
        .catch(() => {});
    }, 4000);
    return () => { stop = true; clearInterval(t); };
  }, [state, bridged, agent.slug, limit]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs, busy, bridgeWait]);

  async function send(message: string) {
    const m = message.trim();
    if (!m || busy) return;
    setBusy(true); setError(""); setNote(""); setText("");
    if (bridged) setBridgeWait(true);
    const started = new Date().toISOString();
    setMsgs((x) => [...x, { role: "user", who: "you", body: m, created_at: started }]);
    try {
      const first = await api<{ jobId?: number; status?: string; reply?: string; tools?: string[]; error?: string; bridged?: boolean }>(`/api/agents/${agent.slug}/chat`, { method: "POST", body: JSON.stringify({ message: m, app: hostApp() }) });
      if (first.bridged) {
        setBridgeWait(true);
        waitFrom.current = started;
        const t0 = Date.now();
        let landed = false;
        while (Date.now() - t0 < 12 * 60_000) {
          await new Promise((r) => setTimeout(r, 3000));
          const [thread, job] = await Promise.all([
            api<{ messages: Msg[] }>(`/api/agents/${agent.slug}/chat?limit=${limit}`),
            first.jobId ? api<{ status: string; reply?: string; error?: string }>(`/api/agents/${agent.slug}/chat/jobs/${first.jobId}`) : Promise.resolve(null),
          ]);
          setMsgs((prev) => mergeThread(prev, thread.messages));
          if (job?.status === "failed") throw new Error(job.error || "Chris hit an error");
          if (job?.status === "done" || thread.messages.some((msg) => msg.role === "agent" && msg.meta?.conversation_id === `app:${first.jobId}`)) {
            if (job?.reply && !thread.messages.some((msg) => msg.role === "agent" && msg.body === job.reply)) {
              setMsgs((prev) => [...prev, { role: "agent", who: agent.name, body: job.reply!, created_at: new Date().toISOString() }]);
            }
            landed = true;
            break;
          }
        }
        if (!landed) setNote("Chris is still working on it. Leave this chat open — the reply will show up here when it lands.");
        return;
      }
      setBridgeWait(false);
      let final = first;
      if (first.jobId && first.status !== "done" && first.status !== "failed") {
        const t0 = Date.now();
        while (Date.now() - t0 < 600_000) {
          await new Promise((r) => setTimeout(r, 2500));
          const j = await api<{ status: string; reply?: string; tools?: string[]; error?: string }>(`/api/agents/${agent.slug}/chat/jobs/${first.jobId}`);
          if (j.status === "done" || j.status === "failed") { final = { ...first, ...j }; break; }
        }
      }
      if (final.status === "failed") throw new Error(final.error || `${agent.name} hit an error`);
      if (!final.reply) throw new Error(`${agent.name} is taking longer than ten minutes — the reply will appear in the thread when it lands.`);
      setMsgs((x) => [...x, { role: "agent", who: agent.name, body: final.reply!, created_at: new Date().toISOString(), meta: { tools: final.tools } }]);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); setBridgeWait(false); }
  }

  if (state === "off") return null;
  return (
    <div className={`card chat${compact ? " compact" : ""}`}>
      {!compact && (
        <h2>Chat with {agent.name}{" "}
          <span className="muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>
            {agent.slug === "chris"
              ? bridged
                ? "· a reply can take a minute; it shows up in this thread."
                : "· in-app shop mind, until the Cristofori GrokBot webhook is set on this deployment"
              : "· answers from the Knowledge Vault + Sales Console, no Hermes needed"}
          </span>
        </h2>
      )}
      {state === "unconfigured" && <div className="banner warn">⚠ {error || "In-app chat isn't configured on this deployment."}</div>}
      <div className="chat-log">
        {state === "ready" && msgs.length === 0 && (
          <div className="muted" style={{ padding: 12 }}>
            {agent.slug === "chris"
              ? "No messages yet. Ask about the queue, a stalled piano, or a before video — include the serial number."
              : `No messages yet. Ask ${agent.name} anything about the pipeline, a lead, or a draft.`}
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={m.id ?? `t${i}`} className={`chat-msg ${m.role}`}>
            <div className="chat-meta">{m.role === "agent" ? agent.name : m.who || "teammate"} · {stamp(m.created_at)}{m.meta?.tools?.length ? <span className="muted"> · looked up: {[...new Set(m.meta.tools)].join(", ")}</span> : null}</div>
            <div className="chat-body">{renderLite(m.body)}</div>
          </div>
        ))}
        {busy && !bridgeWait && <div className="chat-msg agent thinking"><div className="chat-meta">{agent.name}</div><div className="chat-body muted">Reading the vault and the pipeline…</div></div>}
        <div ref={end} />
      </div>
      {busy && bridgeWait && <div className="banner info" role="status" style={{ margin: "8px 0" }}>Chris is working on it. This can take a minute — the reply will show up here.</div>}
      {note && state === "ready" && <div className="banner warn" style={{ margin: "8px 0" }}>{note}</div>}
      {error && state === "ready" && <div className="banner bad" style={{ margin: "8px 0" }}>⚠ {error}</div>}
      {state === "ready" && (
        <>
          {msgs.length === 0 && QUICK[agent.slug] && <div className="chat-quick">{QUICK[agent.slug].map((q) => <button key={q} type="button" className="chip filterbtn" onClick={() => send(q)}>{q}</button>)}</div>}
          <form className="chat-form" onSubmit={(e) => { e.preventDefault(); send(text); }}>
            <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={`Message ${agent.name}… (Enter sends, Shift+Enter for a new line)`} rows={compact ? 2 : 3} disabled={busy} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); } }} />
            <button className="btn" type="submit" disabled={busy || !text.trim()}>{busy ? "…" : "Send"}</button>
          </form>
        </>
      )}
    </div>
  );
}
