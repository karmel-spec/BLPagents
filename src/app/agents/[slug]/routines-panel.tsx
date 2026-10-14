"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";
import type { AgentConfig } from "@/lib/agents";
import { ago } from "../../fleet-shared";

/**
 * Routines panel (Brigham, 2026-10-14): the team sets routines for a Grok Bot
 * agent right here — what to do, when (Denver time), which days, and where the
 * answer goes (the agent's thread always; a Telegram chat or the team group
 * optionally). The console's scheduler wakes the agent's Bot at that time.
 */
interface Routine { id: number; title: string; prompt: string; hour: number; minute: number; days: number[]; deliver: { telegramChatId?: string; teamGroup?: boolean }; enabled: boolean; created_by: string; last_run_at: string | null; last_status: string | null; last_summary: string | null; last_job_id: number | null }
interface Run { id: number; routine?: number; title?: string; who: string; status: string; summary?: string; error?: string; started: string | null; finished: string | null }
interface Resp { now: { stamp: string }; paused: boolean; engine: string; routines: Routine[]; runs: Run[]; error?: string }

const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const pad = (n: number) => String(n).padStart(2, "0");
const blank = { title: "", prompt: "", time: "08:00", days: [1, 2, 3, 4, 5], telegramChatId: "", teamGroup: false };

export default function RoutinesPanel({ agent }: { agent: AgentConfig }) {
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState<number | "new" | null>(null);
  const [flash, setFlash] = useState("");

  const load = useCallback(() => api<Resp>(`/api/agents/${agent.slug}/routines`).then((r) => { setData(r); setError(""); }).catch((e) => setError(e.message)), [agent.slug]);
  useEffect(() => { load(); }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy("new"); setFlash("");
    try {
      const [h, m] = form.time.split(":").map(Number);
      await api(`/api/agents/${agent.slug}/routines`, { method: "POST", body: JSON.stringify({ title: form.title, prompt: form.prompt, hour: h, minute: m, days: form.days, deliver: { telegramChatId: form.telegramChatId || undefined, teamGroup: form.teamGroup } }) });
      setForm(blank); setOpen(false); setFlash("Routine saved — it runs at that time (Denver) on the days you picked.");
      await load();
    } catch (err) { setFlash(`⚠ ${(err as Error).message}`); } finally { setBusy(null); }
  }
  async function toggle(r: Routine) {
    setBusy(r.id);
    try { await api(`/api/agents/${agent.slug}/routines/${r.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !r.enabled }) }); await load(); }
    catch (err) { setFlash(`⚠ ${(err as Error).message}`); } finally { setBusy(null); }
  }
  async function remove(r: Routine) {
    if (!window.confirm(`Delete the routine “${r.title}”?`)) return;
    setBusy(r.id);
    try { await api(`/api/agents/${agent.slug}/routines/${r.id}`, { method: "DELETE" }); await load(); }
    catch (err) { setFlash(`⚠ ${(err as Error).message}`); } finally { setBusy(null); }
  }
  async function runNow(r: Routine) {
    setBusy(r.id); setFlash("");
    try {
      const j = await api<{ jobId?: number; status?: string; error?: string }>(`/api/agents/${agent.slug}/routines/${r.id}/run`, { method: "POST" });
      setFlash(j.error ? `⚠ ${j.error}` : `Started (job ${j.jobId}) — ${data?.engine === "grokbot" ? `${agent.name}'s Grok Bot has been woken; the answer lands in the thread above` : "running in the cloud; the answer lands in the thread above"}.`);
      setTimeout(load, 4000);
    } catch (err) { setFlash(`⚠ ${(err as Error).message}`); } finally { setBusy(null); }
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0 }}>Routines <span className="muted" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· what {agent.name} does on a schedule, set by the team</span></h2>
        <span style={{ flex: 1 }} />
        {data && <span className="chip">{data.engine === "grokbot" ? "runs on the Grok Bot" : data.engine === "bridge" ? "per-agent bridge" : "runs on the console mind until the Bot is wired"}</span>}
        {data?.paused && <span className="chip">⏸ scheduler paused (ROUTINES_PAUSED)</span>}
        <button className="btn" type="button" onClick={() => setOpen((o) => !o)}>{open ? "Cancel" : "+ New routine"}</button>
      </div>
      {error && <div className="banner bad" style={{ marginTop: 10 }}>⚠ {error}</div>}
      {flash && <div className={`banner ${flash.startsWith("⚠") ? "bad" : "info"}`} style={{ marginTop: 10 }}>{flash}</div>}

      {open && (
        <form onSubmit={create} style={{ marginTop: 12, display: "grid", gap: 8 }}>
          <input required placeholder="Title — e.g. Monday fleet report" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <textarea required rows={4} placeholder={`What should ${agent.name} do? Write it like you'd say it in chat. Say where facts come from (vault file, Store Map, Sales Console) and how to format the answer.`} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} />
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <label>Time (Denver) <input type="time" required value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} /></label>
            <span>
              {DAYS.map((d, i) => (
                <label key={d} style={{ marginRight: 8 }}><input type="checkbox" checked={form.days.includes(i)} onChange={(e) => setForm({ ...form, days: e.target.checked ? [...form.days, i].sort() : form.days.filter((x) => x !== i) })} /> {d}</label>
              ))}
            </span>
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <span className="muted">Delivered to {agent.name}&apos;s thread here always. Also:</span>
            <label><input type="checkbox" checked={form.teamGroup} onChange={(e) => setForm({ ...form, teamGroup: e.target.checked })} /> the team Telegram group</label>
            <label>Telegram chat id <input placeholder="optional, e.g. 8912879819" value={form.telegramChatId} onChange={(e) => setForm({ ...form, telegramChatId: e.target.value })} style={{ width: 180 }} /></label>
          </div>
          <div><button className="btn" type="submit" disabled={busy === "new"}>{busy === "new" ? "Saving…" : "Save routine"}</button></div>
        </form>
      )}

      {data && data.routines.length === 0 && !open && <p className="muted" style={{ marginTop: 10 }}>No routines yet. “+ New routine” — for example a daily 7:30 summary, a Monday report, or an evening check.</p>}
      {data && data.routines.length > 0 && (
        <table style={{ width: "100%", marginTop: 12, borderCollapse: "collapse" }}>
          <thead><tr className="muted"><th style={{ textAlign: "left" }}>Routine</th><th style={{ textAlign: "left" }}>When</th><th style={{ textAlign: "left" }}>Last run</th><th /></tr></thead>
          <tbody>
            {data.routines.map((r) => (
              <tr key={r.id} style={{ borderTop: "1px solid rgba(0,0,0,.08)", opacity: r.enabled ? 1 : 0.55 }}>
                <td style={{ padding: "8px 6px 8px 0", verticalAlign: "top" }}>
                  <div><strong>{r.title}</strong>{!r.enabled && <span className="chip" style={{ marginLeft: 6 }}>paused</span>}</div>
                  <div className="muted" style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{r.prompt.length > 220 ? `${r.prompt.slice(0, 220)}…` : r.prompt}</div>
                  <div className="muted" style={{ fontSize: 11 }}>set by {r.created_by || "the team"}{r.deliver?.teamGroup ? " · → team group" : ""}{r.deliver?.telegramChatId ? ` · → Telegram ${r.deliver.telegramChatId}` : ""}</div>
                </td>
                <td style={{ padding: "8px 6px", verticalAlign: "top", whiteSpace: "nowrap" }}>{pad(r.hour)}:{pad(r.minute)}<br /><span className="muted" style={{ fontSize: 12 }}>{r.days.map((d) => DAYS[d]).join(" ")}</span></td>
                <td style={{ padding: "8px 6px", verticalAlign: "top", fontSize: 12 }}>
                  {r.last_run_at ? <>{r.last_status === "failed" ? "⚠ " : r.last_status === "running" ? "⏳ " : "✓ "}{ago(r.last_run_at)} ago<br /><span className="muted">{r.last_summary || r.last_status}</span></> : <span className="muted">never</span>}
                </td>
                <td style={{ padding: "8px 0 8px 6px", verticalAlign: "top", whiteSpace: "nowrap", textAlign: "right" }}>
                  <button className="btn ghost" type="button" disabled={busy === r.id} onClick={() => runNow(r)}>Run now</button>{" "}
                  <button className="btn ghost" type="button" disabled={busy === r.id} onClick={() => toggle(r)}>{r.enabled ? "Pause" : "Resume"}</button>{" "}
                  <button className="btn ghost" type="button" disabled={busy === r.id} onClick={() => remove(r)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data && data.runs.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary className="muted">Recent routine runs ({data.runs.length})</summary>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 12 }}>
            {data.runs.map((j) => <li key={j.id}>{j.title || `routine ${j.routine}`} — {j.status}{j.summary ? `: ${j.summary}` : ""}{j.error ? ` — ${j.error}` : ""} <span className="muted">({j.who}, {j.finished ? `${ago(j.finished)} ago` : "running"})</span></li>)}
          </ul>
        </details>
      )}
    </div>
  );
}
