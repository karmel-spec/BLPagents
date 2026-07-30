"use client";

import { useState } from "react";

export default function LoginPage() {
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error || "Wrong passcode");
      }
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/blp-logo.png" alt="Brigham Larson Pianos" style={{ width: 200, maxWidth: "100%", height: "auto" }} />
        <div className="rule"><i /><b /><i /></div>
        <div className="caps" style={{ fontSize: 15 }}>AGENT CONSOLE</div>
        <a className="btn" href="/api/auth/google" style={{ display: "block", margin: "20px 0 6px" }}>
          Sign in with Google
        </a>
        <p className="muted" style={{ margin: "4px 0 14px", fontSize: 12 }}>@brighamlarsonpianos.com accounts — or use the team passcode:</p>
        {error && <div className="banner bad" style={{ textAlign: "left" }}>⚠ {error}</div>}
        <form onSubmit={submit}>
          <input
            type="password"
            placeholder="Passcode"
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
            autoFocus
          />
          <button className="btn ghost" style={{ marginTop: 12, width: "100%" }} disabled={busy || !passcode}>
            {busy ? "Checking…" : "Enter with passcode"}
          </button>
        </form>
      </div>
    </div>
  );
}
