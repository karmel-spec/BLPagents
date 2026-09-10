"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client";

/**
 * Mind & memory — the agent's files in the BLP Knowledge Vault repo on GitHub.
 * Anyone signed in to the console can read them by link and edit them here;
 * every save is a commit with the editor's name. Agents on any machine pull
 * the same repo, so there is no "the copy on Karmel's Mac" any more.
 */

interface Entry { name: string; path: string; type: "file" | "dir"; size: number; htmlUrl: string }
interface VaultFile { path: string; content: string; sha: string; size: number; htmlUrl: string }

const PRIORITY = ["IDENTITY.md", "SOUL.md", "AGENTS.md", "STATUS.md", "MEMORY.md", "TODO.md"];
const rank = (n: string) => { const i = PRIORITY.indexOf(n); return i === -1 ? 99 : i; };

export default function MindPanel({ folders, agentName }: { folders: string[]; agentName: string }) {
  const [lists, setLists] = useState<Record<string, Entry[] | "missing" | "loading">>({});
  const [repoUrl, setRepoUrl] = useState<string>("");
  const [unconfigured, setUnconfigured] = useState(false);
  const [open, setOpen] = useState<VaultFile | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: "ok" | "bad"; text: string } | null>(null);

  useEffect(() => {
    folders.forEach(async (f) => {
      setLists((s) => ({ ...s, [f]: "loading" }));
      try {
        const r = await api<{ entries: Entry[]; url: string }>(`/api/vault?path=${encodeURIComponent(f)}`);
        setRepoUrl(r.url.split("/blob/")[0]);
        setLists((s) => ({ ...s, [f]: r.entries.filter((e) => e.type === "file" && /\.(md|txt|json|ya?ml)$/i.test(e.name)).sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name)) }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/VAULT_GITHUB_TOKEN/.test(msg)) setUnconfigured(true);
        setLists((s) => ({ ...s, [f]: "missing" }));
      }
    });
  }, [folders]);

  const load = useCallback(async (path: string) => {
    setBusy(true); setNote(null); setEditing(false);
    try {
      const r = await api<{ file: VaultFile }>(`/api/vault?kind=file&path=${encodeURIComponent(path)}`);
      setOpen(r.file); setDraft(r.file.content);
    } catch (e) {
      setNote({ kind: "bad", text: e instanceof Error ? e.message : String(e) });
    } finally { setBusy(false); }
  }, []);

  async function save() {
    if (!open) return;
    setBusy(true); setNote(null);
    try {
      const r = await api<{ sha: string; commitUrl: string; author: string }>("/api/vault", {
        method: "PUT",
        body: JSON.stringify({ path: open.path, content: draft, sha: open.sha, message: `Update ${open.path.split("/").pop()} for ${agentName} via Agent Console` }),
      });
      setOpen({ ...open, content: draft, sha: r.sha });
      setEditing(false);
      setNote({ kind: "ok", text: `Saved as a commit by ${r.author}. ${agentName} picks it up on the next sync.` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setNote({ kind: "bad", text: /409|sha/i.test(msg) ? "Someone else saved this file first. Reopen it, then re-apply your change." : msg });
    } finally { setBusy(false); }
  }

  if (unconfigured) {
    return (
      <div className="card">
        <h2>Mind &amp; memory</h2>
        <div className="banner bad" style={{ marginTop: 8 }}>
          This deployment can&apos;t reach the Knowledge Vault repo yet — set <span className="mono">VAULT_GITHUB_TOKEN</span> on Netlify (fine-grained token, Contents read/write on karmel-spec/blp-knowledge-vault).
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Files: {folders.map((f) => <span key={f} className="mono" style={{ marginRight: 8 }}>{f}/</span>)}
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Mind &amp; memory</h2>
      <div className="muted" style={{ fontSize: 12, margin: "4px 0 10px" }}>
        {agentName}&apos;s files live in the shared <a href={repoUrl || "https://github.com/karmel-spec/blp-knowledge-vault"} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>BLP Knowledge Vault repo ↗</a>.
        Read them here, edit them here — every save is a commit with your name — and every machine running {agentName} pulls the same copy.
      </div>

      {folders.map((f) => {
        const l = lists[f];
        return (
          <div key={f} style={{ marginBottom: 10 }}>
            <div className="mono" style={{ fontSize: 11.5, opacity: 0.7 }}>{f}/</div>
            {l === "loading" && <div className="muted" style={{ fontSize: 12 }}>loading…</div>}
            {l === "missing" && <div className="muted" style={{ fontSize: 12 }}>not in the repo (machine-only or not created yet)</div>}
            {Array.isArray(l) && l.length === 0 && <div className="muted" style={{ fontSize: 12 }}>no text files here</div>}
            {Array.isArray(l) && l.map((e) => (
              <div key={e.path} style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "5px 0", borderBottom: "1px solid var(--line-soft)" }}>
                <button className="btn" style={{ padding: "2px 8px", fontSize: 12.5, fontWeight: open?.path === e.path ? 700 : 400 }} onClick={() => load(e.path)} disabled={busy}>
                  {e.name}
                </button>
                <span className="muted" style={{ fontSize: 11 }}>{(e.size / 1024).toFixed(1)} KB</span>
                <span style={{ flex: 1 }} />
                <a href={e.htmlUrl} target="_blank" rel="noreferrer" className="muted" style={{ fontSize: 11, textDecoration: "underline" }}>GitHub ↗</a>
              </div>
            ))}
          </div>
        );
      })}

      {open && (
        <div style={{ marginTop: 12, borderTop: "2px solid var(--line-soft)", paddingTop: 10 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <strong className="mono" style={{ fontSize: 12.5 }}>{open.path}</strong>
            <span style={{ flex: 1 }} />
            {!editing && <button className="btn" onClick={() => setEditing(true)} disabled={busy}>Edit</button>}
            {editing && (
              <>
                <button className="btn" onClick={save} disabled={busy || draft === open.content}>{busy ? "Saving…" : "Save (commit)"}</button>
                <button className="btn" onClick={() => { setDraft(open.content); setEditing(false); }} disabled={busy}>Cancel</button>
              </>
            )}
            <button className="btn" onClick={() => { setOpen(null); setNote(null); }} disabled={busy}>Close</button>
          </div>
          {note && <div className={`banner ${note.kind === "ok" ? "" : "bad"}`} style={{ marginTop: 8, fontSize: 12.5 }}>{note.text}</div>}
          {editing ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              style={{ width: "100%", minHeight: 420, marginTop: 8, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12.5, lineHeight: 1.45, padding: 10, border: "1px solid var(--line-soft)", borderRadius: 6, background: "var(--paper, #fff)", color: "inherit" }}
            />
          ) : (
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12.5, lineHeight: 1.45, marginTop: 8, maxHeight: 520, overflow: "auto", padding: 10, border: "1px solid var(--line-soft)", borderRadius: 6 }}>{open.content}</pre>
          )}
        </div>
      )}
    </div>
  );
}
