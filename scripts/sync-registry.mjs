#!/usr/bin/env node
/**
 * Regenerate src/lib/agent-registry.json from Karmel's agent-registry sheet
 * ("Agents" tab). The sheet is the source of truth for identity fields
 * (name, department, role, status, runtime, email, telegram, supervisor);
 * console-owned presentation fields (accent color, avatar, tagline) are
 * preserved from the existing JSON — new agents get a department accent and
 * a portrait path if one exists in public/agents/.
 *
 *   npm run sync-registry
 *
 * Requires GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY in env or
 * .env.local, with the sheet shared to that service account.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_SHEET_ID = process.env.REGISTRY_SHEET_ID || "1mqCmkCD59s6OrgQMjqPZiLc3y1m426WBVUyaQ9F-aTI";
const REGISTRY_TAB = process.env.REGISTRY_TAB || "Agents";
const JSON_PATH = path.join(ROOT, "src/lib/agent-registry.json");

// --- env (process env, falling back to .env.local) ---
function envVal(name) {
  if (process.env[name]) return process.env[name];
  const envFile = path.join(ROOT, ".env.local");
  if (!fs.existsSync(envFile)) return "";
  const m = fs.readFileSync(envFile, "utf8").match(new RegExp(`^${name}=(.+)$`, "m"));
  return m ? m[1].trim().replace(/^"|"$/g, "") : "";
}
const EMAIL = envVal("GOOGLE_SERVICE_ACCOUNT_EMAIL");
const KEY = envVal("GOOGLE_PRIVATE_KEY").replace(/\\n/g, "\n");
if (!EMAIL || !KEY) {
  console.error("Missing GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY (env or .env.local).");
  process.exit(1);
}

async function token() {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: EMAIL,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  const assertion = `${unsigned}.${signer.sign(KEY).toString("base64url")}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${await res.text()}`);
  return (await res.json()).access_token;
}

const TOK = await token();
const res = await fetch(
  `https://sheets.googleapis.com/v4/spreadsheets/${REGISTRY_SHEET_ID}/values/${encodeURIComponent(REGISTRY_TAB)}?majorDimension=ROWS`,
  { headers: { Authorization: `Bearer ${TOK}` } }
);
if (!res.ok) throw new Error(`sheet read failed (${res.status}): ${await res.text()}`);
const rows = (await res.json()).values || [];

// Header row is row 3 (instructions live in the README tab).
const header = (rows[2] || []).map((h) => (h || "").split("\n")[0].trim().toLowerCase());
const idx = (name) => header.findIndex((h) => h.startsWith(name));
const C = {
  name: idx("agent name"),
  dept: idx("department"),
  role: idx("agent title"),
  status: idx("agent status"),
  supervisor: idx("(owner) human supervisor"),
  email: idx("agent email"),
  telegram: idx("telegram handle"),
  telegramActive: idx("telegram active"),
  homeComputer: idx("home computer"),
  runtime: idx("runtime_system"),
  crons: idx("current active cron jobs"),
  slug: idx("agent_slug"),
};
for (const [k, v] of Object.entries(C)) {
  if (v < 0) throw new Error(`Column "${k}" not found in header row 3 — aborting, JSON untouched.`);
}

const existing = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
const bySlug = new Map(existing.map((a) => [a.slug, a]));
const deptAccent = new Map(existing.map((a) => [a.department, a.accent]));

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
/** Sheet cells wrap with hard newlines — collapse all whitespace runs. */
const clean = (v) => (v || "").replace(/\s+/g, " ").trim();
const out = [];
const seen = new Set();

for (const r of rows.slice(3)) {
  const name = clean(r[C.name]);
  if (!name) continue;
  const slug = clean(r[C.slug]) || slugify(name);
  if (seen.has(slug)) {
    console.warn(`  duplicate slug "${slug}" — keeping the first row`);
    continue;
  }
  seen.add(slug);
  const prev = bySlug.get(slug) || {};
  const dept = clean(r[C.dept]) || prev.department || "Operations";
  const telegramHandle = clean(r[C.telegram]).replace(/^@/, "");
  const avatarFile = `agents/${slug}.jpg`;
  const hasAvatar = fs.existsSync(path.join(ROOT, "public", avatarFile));

  out.push({
    slug,
    name,
    role: clean(r[C.role]) || prev.role || "",
    department: dept,
    tagline: prev.tagline || `${(r[C.role] || name).trim()} agent — profile from the BLP agent registry.`,
    reportsTo: clean(r[C.supervisor]) || prev.reportsTo || "Karmel",
    accent: prev.accent || deptAccent.get(dept) || "#5b574f",
    avatar: prev.avatar || (hasAvatar ? `/${avatarFile}` : null),
    email: clean(r[C.email]) || prev.email || null,
    runtime: clean(r[C.runtime]) || prev.runtime || null,
    registryStatus: clean(r[C.status]) || prev.registryStatus || "On Deck",
    crons: clean(r[C.crons]) || prev.crons || null,
    homeComputer: clean(r[C.homeComputer]) || prev.homeComputer || null,
    telegram: telegramHandle ? `https://t.me/${telegramHandle}` : prev.telegram || null,
    telegramActive: C.telegramActive >= 0 && /^y/i.test(clean(r[C.telegramActive]))
      ? true
      : Boolean(prev.telegramActive),
  });
}

if (out.length < 20) throw new Error(`Only ${out.length} agents parsed — refusing to overwrite JSON.`);

const dropped = existing.filter((a) => !seen.has(a.slug)).map((a) => a.slug);
if (dropped.length) console.warn(`  in JSON but not in sheet (removed): ${dropped.join(", ")}`);

fs.writeFileSync(JSON_PATH, JSON.stringify(out, null, 2) + "\n");
console.log(`Wrote ${out.length} agents to src/lib/agent-registry.json (${dropped.length} removed).`);
