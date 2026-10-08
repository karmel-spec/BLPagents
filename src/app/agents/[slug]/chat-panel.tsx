"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import type { AgentConfig } from "@/lib/agents";
import { findGrokbotReply, GROKBOT_POLL_MS, GROKBOT_REPLY_TIMEOUT_MS, IVORY_MOVING_NOTICE, IVORY_TIMEOUT_NOTICE, type GrokbotSource } from "@/lib/grokbot-shared";

/**
 * In-app chat with an agent — the agent's own mind (vault files) + the Claude
 * API, no Hermes. One thread per agent, shared across the apps (same rows the
 * Store Map chat shows). Used on the agent page and full-height in the popup.
 *
 * Ivory is the exception: her turns are stored the same way, then handed to
 * Ivory Grok Bot. The panel waits until that bot inserts the reply.
 */
type Msg = {
  id?: number;
  role: "user" | "agent" | "assistant";
  who?: string;
  body: string;
  created_at?: string;
  run_id?: string | null;
  reply_to?: number | null;
  meta?: { tools?: string[]; in_reply_to?: number | null } | null;
};

type Posted = {
  provider?: string;
  status?: string;
  messageId?: number;
  notice?: string;
  webhook?: boolean;
  jobId?: number;
  reply?: string;
  tools?: string[];
  error?: string;
};

const stamp = (iso?: string) => (iso ? new Date(iso) : new Date()).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const QUICK: Record<string, string[]> = {
  lindsay: ["What's open on Karmel's asks list right now?", "Look up this customer in QuickBooks and tell me what they still owe.", "Which agents are live and which are waiting on something?"],
  clara: ["What's on Brigham's plate this week according to your sources?", "Which inbox cleanup rules are approved and which are still proposals?", "Suggest three customer engagement ideas for this month."],
  chris: ["What's at the front of the shop queue and what's it waiting on?", "Which pianos are stuck in a phase longer than the time standard?", "Find the piano for the customer I name next."],
  marcus: ["Which for-sale pianos deserve a post this week and why?", "Write a KSL listing for the piano I name next.", "What does our brand voice guide say about pricing in posts?"],
  ivory: ["What's open on your TODO list right now?", "Walk me through the scheduling and intake playbook in five lines.", "What tuning appointments need confirmation?"],
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

export default function ChatPanel({ agent, compact = false, source: sourceProp = "console" }: { agent: AgentConfig; compact?: boolean; source?: GrokbotSource }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [state, setState] = useState<"loading" | "off" | "unconfigured" | "ready">("loading");
  const [provider, setProvider] = useState(agent.provider);
  const [source, setSource] = useState<GrokbotSource>(sourceProp);
  const end = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const grokbot = provider === "grokbot" || agent.provider === "grokbot";

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (sourceProp !== "console") { setSource(sourceProp); return; }
    if (new URLSearchParams(window.location.search).get("from") === "faces") setSource("faces-widget");
  }, [sourceProp]);

  useEffect(() => {
    api<{ enabled: boolean; configured?: boolean; provider?: "grokbot"; webhook?: boolean; messages: Msg[]; error?: string }>(`/api/agents/${agent.slug}/chat?limit=${compact ? 60 : 120}`)
      .then((r) => {
        if (!r.enabled) setState("off");
        else if (r.configured === false) { setState("unconfigured"); setError(r.error || ""); }
        else {
          setState("ready");
          setMsgs(r.messages);
          if (r.provider === "grokbot") setProvider("grokbot");
          if (r.provider === "grokbot" && r.webhook === false) setNotice(IVORY_MOVING_NOTICE);
        }
      })
      .catch((e) => { setState("unconfigured"); setError(e.message); });
  }, [agent.slug, compact]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs, busy]);

  async function finishGrokbot(first: Posted, original: string) {
    if (first.status === "moving") {
      setMsgs((x) => x.slice(0, -1));
      setText(original);
      setNotice(first.notice || IVORY_MOVING_NOTICE);
      return;
    }
    const messageId = first.messageId;
    if (!messageId) throw new Error(first.error || `${agent.name} didn't take that message.`);
    const t0 = Date.now();
    for (;;) {
      if (!alive.current) return;
      try {
        const h = await api<{ messages: Msg[] }>(`/api/agents/${agent.slug}/chat?limit=${compact ? 60 : 120}`);
        if (!alive.current) return;
        setMsgs(h.messages);
        if (findGrokbotReply(h.messages, messageId)) return;
      } catch { /* a blip while polling should not drop the pending state */ }
      if (Date.now() - t0 >= GROKBOT_REPLY_TIMEOUT_MS) break;
      await new Promise((r) => setTimeout(r, GROKBOT_POLL_MS));
    }
    setNotice(IVORY_TIMEOUT_NOTICE);
  }

  async function send(message: string) {
    const m = message.trim();
    if (!m || busy) return;
    setBusy(true); setError(""); setNotice(""); setText("");
    setMsgs((x) => [...x, { role: "user", who: "you", body: m, created_at: new Date().toISOString() }]);
    try {
      const first = await api<Posted>(`/api/agents/${agent.slug}/chat`, { method: "POST", body: JSON.stringify({ message: m, source }) });
      if (first.provider === "grokbot" || first.status === "moving" || (first.messageId && !first.jobId)) {
        await finishGrokbot(first, m);
        return;
      }
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
    } catch (e) {
      setError((e as Error).message);
      if (grokbot) {
        try {
          const h = await api<{ messages: Msg[] }>(`/api/agents/${agent.slug}/chat?limit=${compact ? 60 : 120}`);
          setMsgs(h.messages);
        } catch { /* keep the optimistic row */ }
      }
    }
    finally { setBusy(false); }
  }

  if (state === "off") return null;
  const blurb = grokbot ? "Ivory Grok Bot, in the cloud" : "answers from the Knowledge Vault + Sales Console, no Hermes needed";
  return (
    <div className={`card chat${compact ? " compact" : ""}`}>
      {!compact && <h2>Chat with {agent.name} <span className="muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· {blurb}</span></h2>}
      {state === "unconfigured" && <div className="banner warn">⚠ {error || "In-app chat isn't configured on this deployment."}</div>}
      <div className="chat-log">
        {state === "ready" && msgs.length === 0 && (
          <div className="muted" style={{ padding: 12 }}>
            {grokbot
              ? `No messages yet. Ask ${agent.name} about tuning appointments, confirmations, or the admin brief.`
              : `No messages yet. Ask ${agent.name} anything about the pipeline, a lead, or a draft.`}
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={m.id ?? `t${i}`} className={`chat-msg ${m.role === "user" ? "user" : "agent"}`}>
            <div className="chat-meta">{m.role === "user" ? (m.who || "teammate") : agent.name} · {stamp(m.created_at)}{m.meta?.tools?.length ? <span className="muted"> · looked up: {[...new Set(m.meta.tools)].join(", ")}</span> : null}</div>
            <div className="chat-body">{renderLite(m.body)}</div>
          </div>
        ))}
        {busy && <div className="chat-msg agent thinking"><div className="chat-meta">{agent.name}</div><div className="chat-body muted">{grokbot ? `${agent.name} is working on it…` : "Reading the vault and the pipeline…"}</div></div>}
        <div ref={end} />
      </div>
      {notice && state === "ready" && <div className="banner warn" style={{ margin: "8px 0" }}>{notice}</div>}
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
