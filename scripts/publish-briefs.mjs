#!/usr/bin/env node
/**
 * Publish Hermes agents' daily briefs as Google Docs in the "BLP Shop Briefs"
 * Drive folder, where the Agent Console (and Karmel) read them.
 *
 * Each brief cron is told to save its final Markdown to
 *   ~/.hermes/profiles/<agent>/cron/briefs/<YYYY-MM-DD>.md
 * New files there become
 *   "<Kind> — Wednesday, September 9, 2026"
 * via `gog docs create` (Markdown import) as karmel@. One doc per kind per day.
 *
 * Runs every 15 min from launchd (com.blp.publish-briefs). Idempotent via
 * ~/.hermes/blp-publish-briefs.json.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const HOME = os.homedir();
const HERMES = path.join(HOME, ".hermes");
const FOLDER = process.env.BLP_BRIEFS_FOLDER_ID || "1v_nxxfENOxS9BEXlFevQMFDOwTik_J3a";
const ACCOUNT = process.env.BLP_GOG_ACCOUNT || "karmel@brighamlarsonpianos.com";
const GOG = process.env.GOG_BIN || "/opt/homebrew/bin/gog";
const STATE = path.join(HERMES, "blp-publish-briefs.json");
const MAX_AGE_MS = 2 * 86400_000;

/** profile → doc title prefix (must match BRIEF_SPECS in src/lib/briefings.ts). */
const KINDS = {
  arnold: "Sales Briefing",
  marcus: "Marketing Briefing",
  lindsay: "Operations Briefing",
  clara: "Brigham's Daily Brief",
};

const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : { published: {} };
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

function dayKey(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function longDate(d) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(d);
}

/**
 * Only the briefs/ dir counts. Hermes' cron/output/<job>/ files are run
 * logs (header + full prompt, even on failure) — never publish those.
 */
function candidates(profile) {
  const out = [];
  const briefsDir = path.join(HERMES, "profiles", profile, "cron", "briefs");
  if (!fs.existsSync(briefsDir)) return out;
  for (const f of fs.readdirSync(briefsDir)) {
    if (!/\.(md|txt|markdown)$/i.test(f)) continue;
    const p = path.join(briefsDir, f);
    const st = fs.statSync(p);
    if (!st.isFile() || st.size < 200 || Date.now() - st.mtimeMs > MAX_AGE_MS) continue;
    const head = fs.readFileSync(p, "utf8").slice(0, 200);
    if (/^# Cron Job:/.test(head) || /\(FAILED\)/.test(head)) continue; // a run log slipped in
    out.push({ path: p, mtime: st.mtime });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

let published = 0;
for (const [profile, kind] of Object.entries(KINDS)) {
  for (const c of candidates(profile)) {
    const key = `${kind}|${dayKey(c.mtime)}`;
    if (state.published[key]) continue; // one doc per kind per day
    const title = `${kind} — ${longDate(c.mtime)}`;
    try {
      const res = execFileSync(GOG, ["docs", "create", "-a", ACCOUNT, title, "--parent", FOLDER, "--file", c.path, "-p"], {
        encoding: "utf8",
        timeout: 60_000,
      });
      state.published[key] = { title, source: c.path, at: new Date().toISOString(), result: res.trim().slice(0, 200) };
      published++;
      log(`published "${title}" from ${c.path}`);
    } catch (e) {
      log(`FAILED "${title}" from ${c.path}: ${String(e.stderr || e.message).slice(0, 300)}`);
    }
  }
}
fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
if (published === 0) log("nothing new to publish");
