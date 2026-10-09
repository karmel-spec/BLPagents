"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import type { AgentConfig } from "@/lib/agents";
import { findGrokbotReply, GROKBOT_POLL_MS, GROKBOT_REPLY_TIMEOUT_MS, IVORY_MOVING_NOTICE, IVORY_TIMEOUT_NOTICE, type GrokbotSource } from "@/lib/grokbot-shared";
import { isEmbedOrigin } from "@/lib/embed-origins";

/**
 * In-app chat with an agent — the agent's own mind (vault files) + the Claude
 * API, no Hermes. One thread per agent, shared across the apps (same rows the
 * Store Map chat shows). Used on the agent page and full-height in the popup.
 *
 * Ivory is the exception on her own contract: her turns are stored, then handed
 * to Ivory Grok Bot, which inserts the reply. Eddy (slug `ed`) and Chris, when
 * their webhooks are set, use the Grok Bot bridge in grokbot-bridge.ts.
 */
type Msg = {
  id?: number;
  role: "user" | "agent" | "assistant";
  who?: string;
  body: string;
  created_at?: string;
  run_id?: string | null;
  reply_to?: number | null;
  meta?: {
    tools?: string[];
    in_reply_to?: number | null;
    conversation_id?: string;
    channel?: string;
    context?: Record<string, string>;
  } | null;
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
  bridged?: boolean;
};

type ChatContext = { serial?: string; piano?: string; card_url?: string; user?: string };

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
  ed: [
    "What's the next video that needs a Short?",
    "Draft a Shorts title and caption for the serial I'll send next.",
    "What should the thumbnail say for this piano?",
  ],
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

function clip(v: string | null, n: number): string {
  return (v || "").replace(/[\r\n]/g, " ").trim().slice(0, n);
}

/** URL params from an outside page (Marketing Engine video card, assistant.js). */
function contextFromSearch(): { ctx?: ChatContext; draft: string } {
  if (typeof window === "undefined") return { draft: "" };
  const p = new URLSearchParams(window.location.search);
  const serial = clip(p.get("serial"), 80);
  const piano = clip(p.get("piano"), 160);
  const card = clip(p.get("card") || p.get("card_url"), 500);
  const user = clip(p.get("user"), 80);
  const text = clip(p.get("text"), 6000);
  const ctx: ChatContext = {};
  if (serial) ctx.serial = serial;
  if (piano) ctx.piano = piano;
  if (card) ctx.card_url = card;
  if (user) ctx.user = user;
  const draft = text || (serial ? `Serial ${serial}${piano ? ` (${piano})` : ""}.${card ? ` Card: ${card}` : ""}` : "");
  return { ctx: Object.keys(ctx).length ? ctx : undefined, draft };
}

function applyContextMessage(data: unknown): { ctx?: ChatContext; draft: string } | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type !== "blp-agent-context") return null;
  const serial = typeof d.serial === "string" ? clip(d.serial, 80) : "";
  const piano = typeof d.piano === "string" ? clip(d.piano, 160) : "";
  const card = typeof d.card === "string" ? clip(d.card, 500) : typeof d.card_url === "string" ? clip(d.card_url, 500) : "";
  const user = typeof d.user === "string" ? clip(d.user, 80) : "";
  const text = typeof d.text === "string" ? clip(d.text, 6000) : "";
  const ctx: ChatContext = {};
  if (serial) ctx.serial = serial;
  if (piano) ctx.piano = piano;
  if (card) ctx.card_url = card;
  if (user) ctx.user = user;
  const draft = text || (serial ? `Serial ${serial}${piano ? ` (${piano})` : ""}.${card ? ` Card: ${card}` : ""}` : "");
  return { ctx: Object.keys(ctx).length ? ctx : undefined, draft };
}

export default function ChatPanel({ agent, compact = false, source: sourceProp = "console" }: { agent: AgentConfig; compact?: boolean; source?: GrokbotSource }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [bridgeWait, setBridgeWait] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [note, setNote] = useState("");
  const [bridged, setBridged] = useState(false);
  const [state, setState] = useState<"loading" | "off" | "unconfigured" | "ready">("loading");
  const [provider, setProvider] = useState(agent.provider);
  const [source, setSource] = useState<GrokbotSource>(sourceProp);
  const [viewer, setViewer] = useState("you");
  const [ctx, setCtx] = useState<ChatContext | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<Msg[] | null>(null);
  const [searching, setSearching] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const waitFrom = useRef("");
  const dirty = useRef(false);
  const limit = compact ? 60 : 120;
  const grokbot = provider === "grokbot" || agent.provider === "grokbot";
  const searchable = agent.slug === "ed";

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (sourceProp !== "console") { setSource(sourceProp); return; }
    if (new URLSearchParams(window.location.search).get("from") === "faces") setSource("faces-widget");
  }, [sourceProp]);

  useEffect(() => {
    const fromUrl = contextFromSearch();
    if (fromUrl.ctx) setCtx(fromUrl.ctx);
    if (fromUrl.draft) setText(fromUrl.draft);
  }, []);

  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      if (!isEmbedOrigin(ev.origin)) return;
      const parsed = applyContextMessage(ev.data);
      if (!parsed) return;
      const data = ev.data as { slug?: string };
      if (data.slug && data.slug !== agent.slug) return;
      setCtx(parsed.ctx);
      if (!dirty.current && parsed.draft) setText(parsed.draft);
      if (ev.source && typeof (ev.source as Window).postMessage === "function") {
        (ev.source as Window).postMessage({ type: "blp-agent-context-ack", slug: agent.slug }, ev.origin);
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [agent.slug]);

  useEffect(() => {
    api<{ enabled: boolean; configured?: boolean; provider?: "grokbot"; webhook?: boolean; bridged?: boolean; messages: Msg[]; error?: string; viewer?: { who: string } }>(`/api/agents/${agent.slug}/chat?limit=${limit}`)
      .then((r) => {
        if (r.viewer?.who) setViewer(r.viewer.who);
        if (!r.enabled) setState("off");
        else if (r.configured === false) { setState("unconfigured"); setError(r.error || ""); }
        else {
          setState("ready");
          setBridged(Boolean(r.bridged));
          setMsgs(r.messages);
          if (r.provider === "grokbot") setProvider("grokbot");
          if (r.provider === "grokbot" && r.webhook === false) setNotice(IVORY_MOVING_NOTICE);
        }
      })
      .catch((e) => { setState("unconfigured"); setError(e.message); });
  }, [agent.slug, limit]);
  // A Grok Bot reply can land a minute later. Poll the thread while this chat is open.
  useEffect(() => {
    if (state !== "ready" || !bridged || grokbot) return;
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
  }, [state, bridged, grokbot, agent.slug, limit]);
  useEffect(() => {
    const q = search.trim();
    if (!searchable || q.length < 2) { setHits(null); setSearching(false); return; }
    let stop = false;
    setSearching(true);
    const t = setTimeout(() => {
      api<{ messages: Msg[] }>(`/api/agents/${agent.slug}/chat?q=${encodeURIComponent(q)}&limit=100`)
        .then((r) => { if (!stop) setHits(r.messages || []); })
        .catch(() => { if (!stop) setHits([]); })
        .finally(() => { if (!stop) setSearching(false); });
    }, 300);
    return () => { stop = true; clearTimeout(t); };
  }, [search, searchable, agent.slug]);
  useEffect(() => { if (!search.trim()) end.current?.scrollIntoView({ block: "end" }); }, [msgs, busy, bridgeWait, search]);

  const working = agent.slug === "chris" ? "Chris is working on it" : `${agent.name} is working on it`;
  const shown = hits ?? msgs;

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
        const h = await api<{ messages: Msg[] }>(`/api/agents/${agent.slug}/chat?limit=${limit}`);
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
    setBusy(true); setError(""); setNotice(""); setNote(""); setText("");
    dirty.current = false;
    if (bridged && !grokbot) setBridgeWait(true);
    const started = new Date().toISOString();
    const whoLabel = !grokbot && agent.slug === "ed" ? (ctx?.user && viewer === "Team" ? ctx.user : viewer) : "you";
    setMsgs((x) => [...x, { role: "user", who: whoLabel, body: m, created_at: started, meta: !grokbot && ctx ? { context: ctx } : undefined }]);
    try {
      if (grokbot) {
        const first = await api<Posted>(`/api/agents/${agent.slug}/chat`, { method: "POST", body: JSON.stringify({ message: m, source }) });
        await finishGrokbot(first, m);
        return;
      }
      const first = await api<Posted>(`/api/agents/${agent.slug}/chat`, {
        method: "POST",
        body: JSON.stringify({ message: m, app: hostApp(), ...(ctx ? { context: ctx } : {}) }),
      });
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
          if (job?.status === "failed") throw new Error(job.error || (agent.slug === "chris" ? "Chris hit an error" : `${agent.name} hit an error`));
          if (job?.status === "done" || thread.messages.some((msg) => msg.role === "agent" && msg.meta?.conversation_id === `app:${first.jobId}`)) {
            if (job?.reply && !thread.messages.some((msg) => msg.role === "agent" && msg.body === job.reply)) {
              setMsgs((prev) => [...prev, { role: "agent", who: agent.name, body: job.reply!, created_at: new Date().toISOString() }]);
            }
            landed = true;
            break;
          }
        }
        if (!landed) {
          setNote(agent.slug === "chris"
            ? "Chris is still working on it. Leave this chat open — the reply will show up here when it lands."
            : `${agent.name} is still working on it. Leave this chat open — the reply will show up here when it lands.`);
        }
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
    } catch (e) {
      setError((e as Error).message);
      if (grokbot) {
        try {
          const h = await api<{ messages: Msg[] }>(`/api/agents/${agent.slug}/chat?limit=${limit}`);
          setMsgs(h.messages);
        } catch { /* keep the optimistic row */ }
      }
    }
    finally { setBusy(false); setBridgeWait(false); }
  }

  if (state === "off") return null;
  const subtitle = grokbot
    ? "· Ivory Grok Bot, in the cloud"
    : agent.slug === "chris"
      ? bridged
        ? "· a reply can take a minute; it shows up in this thread."
        : "· in-app shop mind, until the Cristofori GrokBot webhook is set on this deployment"
      : agent.slug === "ed"
        ? "· Eddy Bot on Grok Bot. A reply can take a minute; it shows up in this thread."
        : "· answers from the Knowledge Vault + Sales Console, no Hermes needed";
  return (
    <div className={`card chat${compact ? " compact" : ""}`}>
      {!compact && (
        <h2>Chat with {agent.name}{" "}
          <span className="muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>{subtitle}</span>
        </h2>
      )}
      {state === "unconfigured" && <div className="banner warn">⚠ {error || "In-app chat isn't configured on this deployment."}</div>}
      {ctx && (ctx.serial || ctx.piano || ctx.card_url || ctx.user) && (
        <div className="banner info chat-context">
          {ctx.serial && <>Serial <b>{ctx.serial}</b></>}
          {ctx.piano && <> · {ctx.piano}</>}
          {ctx.card_url && <> · <a href={ctx.card_url} target="_blank" rel="noreferrer">video card</a></>}
          {ctx.user && <> · opened by {ctx.user}</>}
        </div>
      )}
      {searchable && state === "ready" && (
        <input
          className="chat-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search this thread — words, a person, or a date"
          aria-label="Search Eddy's thread"
        />
      )}
      <div className="chat-log">
        {state === "ready" && shown.length === 0 && (
          <div className="muted" style={{ padding: 12 }}>
            {search.trim().length >= 2
              ? searching ? "Searching…" : "No matches in this thread."
              : grokbot
                ? `No messages yet. Ask ${agent.name} about tuning appointments, confirmations, or the admin brief.`
                : agent.slug === "chris"
                  ? "No messages yet. Ask about the queue, a stalled piano, or a before video — include the serial number."
                  : agent.slug === "ed"
                    ? "No messages yet. Ask about a video and include the serial — or open this chat from a Marketing Engine card."
                    : `No messages yet. Ask ${agent.name} anything about the pipeline, a lead, or a draft.`}
          </div>
        )}
        {search.trim().length >= 2 && hits && hits.length > 0 && (
          <div className="muted" style={{ fontSize: 12 }}>{searching ? "Searching…" : `${hits.length} match${hits.length === 1 ? "" : "es"} in Eddy's thread`}</div>
        )}
        {shown.map((m, i) => (
          <div key={m.id ?? `t${i}`} className={`chat-msg ${m.role === "user" ? "user" : "agent"}`}>
            <div className="chat-meta">
              {m.role === "user" ? (m.who || "teammate") : agent.name} · {stamp(m.created_at)}
              {agent.slug === "ed" && m.meta?.channel === "telegram" ? " · Telegram" : ""}
              {agent.slug === "ed" && m.meta?.context?.serial ? ` · serial ${m.meta.context.serial}` : ""}
              {m.meta?.tools?.length ? <span className="muted"> · looked up: {[...new Set(m.meta.tools)].join(", ")}</span> : null}
            </div>
            <div className="chat-body">{renderLite(m.body)}</div>
          </div>
        ))}
        {busy && grokbot && <div className="chat-msg agent thinking"><div className="chat-meta">{agent.name}</div><div className="chat-body muted">{agent.name} is working on it…</div></div>}
        {busy && !grokbot && !bridgeWait && <div className="chat-msg agent thinking"><div className="chat-meta">{agent.name}</div><div className="chat-body muted">Reading the vault and the pipeline…</div></div>}
        <div ref={end} />
      </div>
      {busy && bridgeWait && !grokbot && <div className="banner info" role="status" style={{ margin: "8px 0" }}>{working}. This can take a minute — the reply will show up here.</div>}
      {notice && state === "ready" && <div className="banner warn" style={{ margin: "8px 0" }}>{notice}</div>}
      {note && state === "ready" && <div className="banner warn" style={{ margin: "8px 0" }}>{note}</div>}
      {error && state === "ready" && <div className="banner bad" style={{ margin: "8px 0" }}>⚠ {error}</div>}
      {state === "ready" && (
        <>
          {msgs.length === 0 && !search.trim() && QUICK[agent.slug] && <div className="chat-quick">{QUICK[agent.slug].map((q) => <button key={q} type="button" className="chip filterbtn" onClick={() => send(q)}>{q}</button>)}</div>}
          <form className="chat-form" onSubmit={(e) => { e.preventDefault(); send(text); }}>
            <textarea value={text} onChange={(e) => { dirty.current = true; setText(e.target.value); }} placeholder={`Message ${agent.name}… (Enter sends, Shift+Enter for a new line)`} rows={compact ? 2 : 3} disabled={busy} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(text); } }} />
            <button className="btn" type="submit" disabled={busy || !text.trim()}>{busy ? "…" : "Send"}</button>
          </form>
        </>
      )}
    </div>
  );
}
