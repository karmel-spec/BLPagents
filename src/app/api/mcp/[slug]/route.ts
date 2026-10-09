import { NextRequest, NextResponse } from "next/server";
import { getAgent } from "@/lib/agents";
import { MINDS, chatEnabled, history, loadMind, runTool, toolsFor } from "@/lib/agent-brain";
import { callbackKeyOk } from "@/lib/engine";
import { completeGrokJob, openGrokJobs } from "@/lib/grokbot-relay";
import { getJob } from "@/lib/agent-brain";
import { getFile, putFile } from "@/lib/vault-github";
import { hasTeamKey } from "@/lib/api";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";
export const maxDuration = 26;

/**
 * MCP server for one agent's Grok Bot — Streamable HTTP transport (JSON-RPC 2.0
 * over POST, one JSON response per request; no SSE stream needed).
 *   URL   https://blpagents.netlify.app/api/mcp/<slug>
 *   Auth  Authorization: Bearer <GROKBOT_CALLBACK_KEY_<SLUG>>   (or x-blp-key)
 * Tools = the agent's own tool set from agent-brain (vault read, Sales Console
 * lookup, Store Map pianos, QuickBooks, approval-gated mail…) + the relay tools:
 *   load_mind        the agent's SOUL / rules / memory from the vault, in one call
 *   open_jobs        messages still waiting for an answer (if a wake was missed)
 *   get_job          one job in full (who, message, channel, how to reply)
 *   thread_history   the shared conversation (console + Telegram + Store Map)
 *   reply_to_team    answer a job — stores, closes, delivers (Telegram, team post, STATUS line)
 *   append_vault_note  add dated notes to a file under Agents/<slug>/ (lessons, memory) as the agent
 * Add it in the Grok Bot app as a custom MCP server (Remote HTTPS) with the key as the bearer header.
 */
const SLUG = /^[a-z0-9-]{1,40}$/;
const TASK_EXTRAS: Record<string, string[]> = { arnold: ["save_top_ten"] };
type Rpc = { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> };

const RELAY_TOOLS = (slug: string) => [
  { name: "load_mind", description: `Your working mind from the BLP Knowledge Vault (${(MINDS[slug]?.core || []).length || "the"} files: SOUL, rules, STATUS, memory, coaching). Call this first on every wake; pass force=true to bypass the 5-minute cache after you edited the vault.`, inputSchema: { type: "object", properties: { force: { type: "boolean" } } } },
  { name: "open_jobs", description: "Messages and tasks still waiting for your answer (jobId, who, where from, message). Use when you were woken without a payload or want to catch up.", inputSchema: { type: "object", properties: {} } },
  { name: "get_job", description: "One job in full: who wrote, from which app or Telegram chat, the message, any task instructions, and the deadline.", inputSchema: { type: "object", properties: { jobId: { type: "number" } }, required: ["jobId"] } },
  { name: "thread_history", description: "The shared conversation with the team (same thread in the Agent Console, Telegram, Store Map and Sales App), newest last.", inputSchema: { type: "object", properties: { limit: { type: "number", description: "default 30, max 120" } } } },
  { name: "reply_to_team", description: "Deliver your answer for a job. Call exactly once per job, with the full reply as plain text (light markdown ok). The console stores it in the shared thread, sends it to the Telegram chat it came from, posts team briefs to the team group, and writes the STATUS line for scheduled tasks.", inputSchema: { type: "object", properties: { jobId: { type: "number" }, reply: { type: "string" } }, required: ["jobId", "reply"] } },
  { name: "append_vault_note", description: `Append a dated note to one of YOUR vault files (path must start with Agents/${slug}/, e.g. Agents/${slug}/MEMORY.md or Agents/${slug}/kb/coaching-feedback.md). Creates the file if missing. Commits to the vault repo as you. Use for lessons, training notes and memory — never for secrets.`, inputSchema: { type: "object", properties: { path: { type: "string" }, note: { type: "string" }, heading: { type: "string", description: "optional heading for the dated section" } }, required: ["path", "note"] } },
];

function toolList(slug: string) {
  const own = toolsFor(slug, TASK_EXTRAS[slug] || []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema }));
  return [...RELAY_TOOLS(slug), ...own];
}

async function callTool(slug: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const n = (v: unknown) => Number(v);
  try {
    if (name === "load_mind") return { text: MINDS[slug] ? await loadMind(slug, Boolean(args.force)) : `No mind list is defined for ${slug} on the console yet — read Agents/${slug}/SOUL.md, AGENTS.md and AGENT_STYLE.md with read_vault_file.` };
    if (name === "open_jobs") {
      const jobs = await openGrokJobs(slug);
      return { text: jobs.length ? JSON.stringify(jobs.map((j) => ({ jobId: j.id, kind: j.kind, who: j.who, from: j.kind === "telegram" ? "telegram" : j.payload?.task ? `task:${j.payload.task}` : j.payload?.event ? `event:${j.payload.event.name}` : "app chat", message: (j.payload?.wakeMessage || j.payload?.message || "").slice(0, 1200), deadline: j.payload?.deadline })), null, 1) : "No open jobs — nothing is waiting for you." };
    }
    if (name === "get_job") {
      const j = await getJob(n(args.jobId));
      if (!j || j.agent !== slug) return { text: `No job ${args.jobId} for ${slug}`, isError: true };
      const { wakePayload } = await import("@/lib/grokbot-relay");
      return { text: JSON.stringify({ status: j.status, ...(await wakePayload(j, j.payload?.wakeMessage ? { message: j.payload.wakeMessage } : {})) }, null, 1) };
    }
    if (name === "thread_history") {
      const rows = await history(slug, Math.min(120, Math.max(5, n(args.limit) || 30)));
      return { text: rows.length ? rows.map((r) => `[${r.created_at.slice(0, 16)}] ${r.role === "agent" ? r.who : `${r.who || "teammate"}${r.meta?.via ? ` via ${r.meta.via}` : ""}`}: ${r.body}`).join("\n\n") : "The thread is empty." };
    }
    if (name === "reply_to_team") {
      const r = await completeGrokJob(slug, n(args.jobId), String(args.reply || ""), "mcp");
      return { text: `Delivered. ${r.telegramMessageIds?.length ? `Telegram message ids ${r.telegramMessageIds.join(",")}. ` : ""}${r.vaultCommit ? `Vault STATUS commit ${r.vaultCommit}. ` : ""}${r.summary || ""}`.trim() };
    }
    if (name === "append_vault_note") {
      const path = String(args.path || "").replace(/^\/+/, "");
      if (!path.startsWith(`Agents/${slug}/`) || path.includes("..")) return { text: `Only files under Agents/${slug}/ may be written from here.`, isError: true };
      const note = String(args.note || "").trim();
      if (!note) return { text: "Empty note", isError: true };
      const existing = await getFile(path);
      const stamp = new Date().toLocaleString("en-US", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
      const section = `\n\n## ${args.heading ? String(args.heading).trim() : "Note"} — ${stamp} (Grok Bot)\n${note}\n`;
      const agent = getAgent(slug);
      const r = await putFile(path, (existing?.content || `# ${agent?.name || slug} — notes\n`).replace(/\s+$/, "") + section, existing?.sha || null, `${agent?.name || slug}: note (Grok Bot)`, { name: `${agent?.name || slug} (BLP agent, Grok Bot)`, email: agent?.email || `${slug}@brighamlarsonpianos.com` });
      return { text: `Appended to ${path} — commit ${r.commitUrl}` };
    }
    const allowed = new Set(toolsFor(slug, TASK_EXTRAS[slug] || []).map((t) => t.name));
    if (!allowed.has(name)) return { text: `Unknown tool ${name}`, isError: true };
    const out = await runTool(name, args, { slug });
    return { text: out, isError: out.startsWith("Tool error:") };
  } catch (e) {
    return { text: `Tool error: ${e instanceof Error ? e.message : String(e)}`, isError: true };
  }
}

async function handle(slug: string, m: Rpc): Promise<Record<string, unknown> | null> {
  const id = m.id ?? null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const err = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  const method = String(m.method || "");
  if (method.startsWith("notifications/")) return null;
  if (method === "initialize") {
    const asked = String((m.params as { protocolVersion?: string } | undefined)?.protocolVersion || "");
    return ok({ protocolVersion: ["2025-06-18", "2025-03-26", "2024-11-05"].includes(asked) ? asked : "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: `blp-agent-console-${slug}`, version: "1.0.0" }, instructions: `You are ${getAgent(slug)?.name || slug}, a BLP agent. Start every wake with load_mind, answer with reply_to_team. Never guess a fact you can look up with a tool.` });
  }
  if (method === "ping") return ok({});
  if (method === "tools/list") return ok({ tools: toolList(slug) });
  if (method === "tools/call") {
    const p = (m.params || {}) as { name?: string; arguments?: Record<string, unknown> };
    const r = await callTool(slug, String(p.name || ""), p.arguments || {});
    return ok({ content: [{ type: "text", text: r.text }], isError: Boolean(r.isError) });
  }
  if (method === "resources/list") return ok({ resources: [] });
  if (method === "prompts/list") return ok({ prompts: [] });
  return err(-32601, `Method not found: ${method}`);
}

function auth(req: NextRequest, slug: string): boolean {
  return callbackKeyOk(slug, req.headers.get("authorization") || req.headers.get("x-blp-key")) || (Boolean(config.accessKey) && hasTeamKey(req));
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  if (!SLUG.test(slug) || !getAgent(slug) || !chatEnabled(slug)) return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "No such agent on this console" } }, { status: 404 });
  if (!auth(req, slug)) return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized — send Authorization: Bearer <GROKBOT_CALLBACK_KEY>" } }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Rpc | Rpc[] | null;
  if (!body) return NextResponse.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 });
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handle(slug, m)))).filter(Boolean);
    return out.length ? NextResponse.json(out) : new NextResponse(null, { status: 202 });
  }
  const out = await handle(slug, body);
  return out ? NextResponse.json(out) : new NextResponse(null, { status: 202 });
}

/** No server-initiated stream: clients that open GET get 405 per the Streamable HTTP spec. */
export async function GET() {
  return NextResponse.json({ error: "Method Not Allowed — this MCP server speaks JSON over POST only" }, { status: 405 });
}
export async function DELETE() { return new NextResponse(null, { status: 200 }); }
