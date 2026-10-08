"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import type { AgentConfig } from "@/lib/agents";

/**
 * Melody's console desk — questions, training, and work requests. Messages go
 * to Grok Bot; her replies land in this thread (and in Telegram, for chats
 * that started there).
 */

type Row = {
  id: string;
  direction: "in" | "out";
  sender_name: string;
  body: string;
  forward_error?: string | null;
  created_at: string;
};

type Thread = {
  configured: boolean;
  bridge?: boolean;
  conversation_id: string | null;
  messages: Row[];
  error?: string;
};

const QUICK = [
  "Walk me through how we handle a new scheduling request.",
  "What should I check before I answer a customer about pricing?",
  "Draft a reply I can send after you show it to me. The customer's note is: ",
];

const stamp = (iso?: string) =>
  (iso ? new Date(iso) : new Date()).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default function MelodyBridge({ agent, compact = false }: { agent: AgentConfig; compact?: boolean }) {
  const [thread, setThread] = useState<Thread | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const end = useRef<HTMLDivElement>(null);

  const load = () =>
    api<Thread>("/api/melody/thread")
      .then((t) => setThread(t))
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [thread?.messages.length, busy]);

  async function send(message: string) {
    const body = message.trim();
    if (!body || busy || thread?.configured === false) return;
    setBusy(true);
    setError("");
    setText("");
    try {
      const result = await api<{ message: Row; forward: { ok: boolean; error?: string }; error?: string }>("/api/melody/thread", {
        method: "POST",
        body: JSON.stringify({ text: body }),
      });
      if (!result.forward.ok) setError(result.error || "Saved here, but Grok Bot did not accept it.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const messages = thread?.messages || [];
  const blocked = thread?.configured === false;

  return (
    <div className={`card chat${compact ? " compact" : ""}`}>
      <h2>
        Ask {agent.name}
        {!compact && (
          <span className="muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>
            {" "}· questions, training, and work requests
          </span>
        )}
      </h2>
      <p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
        {agent.name} runs on Grok Bot. This thread is the team desk
        {agent.telegram ? <> · Telegram stays at <a href={agent.telegram} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>{agent.telegram.replace(/^https?:\/\/t\.me\//, "@")}</a></> : null}.
      </p>
      {blocked && <div className="banner warn">⚠ {thread?.error || error || "Melody's message store is not configured on this deployment."}</div>}
      {!blocked && thread && thread.bridge === false && thread.error && <div className="banner warn">⚠ {thread.error}</div>}
      <div className="chat-log">
        {thread && messages.length === 0 && !blocked && (
          <div className="muted" style={{ padding: 12 }}>No messages yet. Ask {agent.name} for a walkthrough or hand her a task.</div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`chat-msg ${m.direction === "in" ? "user" : "agent"}`}>
            <div className="chat-meta">{m.direction === "out" ? agent.name : m.sender_name || "Team"} · {stamp(m.created_at)}</div>
            <div className="chat-body">{m.body}</div>
            {m.forward_error && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Not delivered to Grok Bot: {m.forward_error}</div>}
          </div>
        ))}
        {busy && <div className="chat-msg agent thinking"><div className="chat-meta">{agent.name}</div><div className="chat-body muted">Sending…</div></div>}
        <div ref={end} />
      </div>
      {error && !blocked && <div className="banner bad" style={{ margin: "8px 0" }}>⚠ {error}</div>}
      {messages.length === 0 && !blocked && (
        <div className="chat-quick">
          {QUICK.map((q) => (
            <button key={q} type="button" className="chip filterbtn" onClick={() => (q.endsWith(" ") ? setText(q) : send(q))}>{q.trim()}</button>
          ))}
        </div>
      )}
      <form className="chat-form" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`Ask ${agent.name} — a question, a training walkthrough, or a work request`}
          rows={compact ? 2 : 3}
          disabled={busy || blocked}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); } }}
        />
        <button className="btn" disabled={busy || blocked || !text.trim()}>{busy ? "Sending…" : "Send"}</button>
      </form>
    </div>
  );
}
