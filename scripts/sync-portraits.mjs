#!/usr/bin/env node
/**
 * Portraits come from the BLP Knowledge Vault (Brigham, 2026-10-14): each Grok Bot
 * saves its face to Agents/<slug>/portrait.jpg. This runs before every build and
 * copies those files into public/agents/<slug>.jpg — the path the console, the
 * Store Map and the Sales App already load — so a new portrait goes live on the
 * next deploy. Eddy's folder is Agents/eddy for console slug `ed`.
 * Needs VAULT_GITHUB_TOKEN (Netlify env; local .env.local). Never fails the build:
 * a missing token or file just keeps the portrait already in the repo.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

for (const l of fs.existsSync(".env.local") ? fs.readFileSync(".env.local", "utf8").split("\n") : []) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const TOKEN = process.env.VAULT_GITHUB_TOKEN || "";
const REPO = process.env.VAULT_GITHUB_REPO || "karmel-spec/blp-knowledge-vault";
const BRANCH = process.env.VAULT_GITHUB_BRANCH || "main";
const FOLDER = { ed: "eddy" };
const registry = JSON.parse(fs.readFileSync("src/lib/agent-registry.json", "utf8"));
const slugs = registry.map((a) => a.slug);

if (!TOKEN) { console.log("[portraits] VAULT_GITHUB_TOKEN not set — keeping the portraits in the repo"); process.exit(0); }

const gh = (p) => fetch(`https://api.github.com/repos/${REPO}/contents/${p}?ref=${BRANCH}`, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github.raw", "User-Agent": "blpagents-portraits" } });
let updated = 0, kept = 0, missing = 0;
for (const slug of slugs) {
  const vaultPath = `Agents/${FOLDER[slug] || slug}/portrait.jpg`;
  try {
    const r = await gh(vaultPath);
    if (r.status === 404) { missing++; continue; }
    if (!r.ok) { console.log(`[portraits] ${slug}: GitHub ${r.status} — kept`); kept++; continue; }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 2000 || !(buf[0] === 0xff && buf[1] === 0xd8)) { console.log(`[portraits] ${slug}: not a JPEG (${buf.length} bytes) — kept`); kept++; continue; }
    const out = path.join("public/agents", `${slug}.jpg`);
    const same = fs.existsSync(out) && crypto.createHash("sha1").update(fs.readFileSync(out)).digest("hex") === crypto.createHash("sha1").update(buf).digest("hex");
    if (same) { kept++; continue; }
    fs.writeFileSync(out, buf);
    updated++; console.log(`[portraits] ${slug}: updated from ${vaultPath} (${buf.length} bytes)`);
  } catch (e) { console.log(`[portraits] ${slug}: ${e.message} — kept`); kept++; }
}
console.log(`[portraits] done — ${updated} updated, ${kept} unchanged, ${missing} without a vault portrait`);
