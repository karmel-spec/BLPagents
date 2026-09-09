#!/usr/bin/env node
/**
 * BLP Agent Gateway — the one locked door between the Agent Console (Netlify)
 * and the Hermes agents running on this Mac.
 *
 *   Console (Next.js API route)  →  https://agents.brighamlarsonpianos.com  (cloudflared)
 *                                →  http://127.0.0.1:8787  (this script)
 *                                →  http://127.0.0.1:86xx/v1/runs  (one Hermes API server per agent)
 *
 * Agents are discovered from ~/.hermes/profiles/<slug>/.env (API_SERVER_PORT /
 * API_SERVER_KEY) — no manifest to maintain. An agent is "live" when its
 * /health answers. Every dispatch is appended to ~/.hermes/blp-dispatch-log.jsonl.
 *
 * Auth: every request carries `x-blp-gateway-key` = keychain
 * blp-agent-console / gateway:key (or env BLP_GATEWAY_KEY). Binds loopback only;
 * never expose 8787 directly — cloudflared is the only way in.
 *
 * Runs as launchd com.blp.agent-gateway.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const HOME = os.homedir();
const PROFILES = path.join(HOME, ".hermes", "profiles");
const LOG = path.join(HOME, ".hermes", "blp-dispatch-log.jsonl");
const PORT = Number(process.env.BLP_GATEWAY_PORT || 8787);
/** Private/family agents never appear in the business console. */
const EXCLUDE = new Set(["diana"]);
const HEALTH_TTL_MS = 30_000;

function gatewayKey() {
  if (process.env.BLP_GATEWAY_KEY) return process.env.BLP_GATEWAY_KEY;
  try {
    return execFileSync("security", ["find-generic-password", "-s", "blp-agent-console", "-a", "gateway:key", "-w"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}
const KEY = gatewayKey();
if (!KEY) {
  console.error("No gateway key (keychain blp-agent-console/gateway:key or BLP_GATEWAY_KEY). Refusing to start.");
  process.exit(1);
}

function readEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^"|"$/g, "");
  }
  return out;
}

/** slug → { port, key } for every profile with an API server configured. */
function discoverAgents() {
  const agents = {};
  if (!fs.existsSync(PROFILES)) return agents;
  for (const slug of fs.readdirSync(PROFILES)) {
    if (EXCLUDE.has(slug)) continue;
    const envFile = path.join(PROFILES, slug, ".env");
    if (!fs.existsSync(envFile)) continue;
    const env = readEnv(envFile);
    if (env.API_SERVER_ENABLED !== "true" || !env.API_SERVER_PORT || !env.API_SERVER_KEY) continue;
    agents[slug] = { port: Number(env.API_SERVER_PORT), key: env.API_SERVER_KEY };
  }
  return agents;
}

const healthCache = new Map(); // slug → { up, at }
async function probe(slug, agent) {
  const hit = healthCache.get(slug);
  if (hit && Date.now() - hit.at < HEALTH_TTL_MS) return hit.up;
  let up = false;
  try {
    const res = await fetch(`http://127.0.0.1:${agent.port}/health`, {
      headers: { Authorization: `Bearer ${agent.key}` },
      signal: AbortSignal.timeout(2500),
    });
    up = res.ok;
  } catch {
    up = false;
  }
  healthCache.set(slug, { up, at: Date.now() });
  return up;
}

async function hermes(agent, method, pathname, body, extraHeaders = {}) {
  const res = await fetch(`http://127.0.0.1:${agent.port}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${agent.key}`, "Content-Type": "application/json", ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 500) }; }
  if (!res.ok) throw Object.assign(new Error(json?.error?.message || json?.detail || `Hermes ${res.status}`), { status: res.status });
  return json;
}

function appendLog(rec) {
  fs.appendFileSync(LOG, JSON.stringify(rec) + "\n");
}
function readLog(slug, limit) {
  if (!fs.existsSync(LOG)) return [];
  const lines = fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean);
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      const r = JSON.parse(lines[i]);
      if (r.type === "dispatch" && (!slug || r.slug === slug)) out.push(r);
    } catch { /* skip a torn line */ }
  }
  return out;
}

function authorized(req) {
  const given = req.headers["x-blp-gateway-key"];
  if (typeof given !== "string" || given.length !== KEY.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(KEY));
}
function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 200_000) reject(new Error("body too large")); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (!authorized(req)) return send(res, 401, { error: "bad gateway key" });
  const agents = discoverAgents();

  try {
    // GET /health → every agent's live state
    if (req.method === "GET" && url.pathname === "/health") {
      const out = {};
      await Promise.all(Object.entries(agents).map(async ([slug, a]) => { out[slug] = { port: a.port, up: await probe(slug, a) }; }));
      return send(res, 200, { ok: true, machine: os.hostname(), agents: out });
    }

    const m = url.pathname.match(/^\/agents\/([a-z0-9-]+)\/(health|runs|dispatches)(?:\/([A-Za-z0-9_-]+))?$/);
    if (!m) return send(res, 404, { error: "not found" });
    const [, slug, what, id] = m;
    const agent = agents[slug];
    if (!agent) return send(res, 404, { error: `no Hermes runtime for "${slug}" on ${os.hostname()}` });

    if (what === "health" && req.method === "GET") {
      return send(res, 200, { slug, up: await probe(slug, agent), port: agent.port });
    }

    if (what === "dispatches" && req.method === "GET") {
      return send(res, 200, { slug, dispatches: readLog(slug, Number(url.searchParams.get("limit") || 10)) });
    }

    // POST /agents/:slug/runs { input, requester } → { run_id, session_id }
    if (what === "runs" && req.method === "POST" && !id) {
      const body = await readBody(req);
      const input = String(body.input || "").trim();
      if (!input) return send(res, 400, { error: "input is required" });
      if (!(await probe(slug, agent))) return send(res, 503, { error: `${slug} is not answering on this Mac` });
      const session_id = `blp-console-${slug}-${Date.now()}`;
      const run = await hermes(agent, "POST", "/v1/runs", { input, session_id }, { "X-Hermes-Session-Key": `agent:${slug}:console` });
      const rec = { type: "dispatch", at: new Date().toISOString(), slug, requester: String(body.requester || "team").slice(0, 80), input: input.slice(0, 2000), run_id: run.run_id, session_id, status: run.status || "started" };
      appendLog(rec);
      return send(res, 200, { ok: true, slug, run_id: run.run_id, session_id, status: rec.status });
    }

    // GET /agents/:slug/runs/:run_id → { status, output }
    if (what === "runs" && req.method === "GET" && id) {
      const run = await hermes(agent, "GET", `/v1/runs/${id}`);
      if (run.status === "completed" || run.status === "failed") {
        appendLog({ type: "result", at: new Date().toISOString(), slug, run_id: id, status: run.status, output: String(run.output || "").slice(0, 4000), usage: run.usage });
      }
      return send(res, 200, { slug, run_id: id, status: run.status, output: run.output ?? null, usage: run.usage ?? null, updated_at: run.updated_at ?? null });
    }

    return send(res, 405, { error: "method not allowed" });
  } catch (err) {
    return send(res, err.status || 502, { error: err.message || String(err) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`${new Date().toISOString()} BLP agent gateway on 127.0.0.1:${PORT} — agents: ${Object.keys(discoverAgents()).sort().join(", ")}`);
});
