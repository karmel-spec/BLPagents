import { NextRequest, NextResponse } from "next/server";
import { getAgent } from "@/lib/agents";
import { MINDS, chatEnabled, toolsFor } from "@/lib/agent-brain";
import { ENGINE_LABEL, engineFor, grokbotCallbackKey, grokbotConfigured, grokbotWebhookUrl } from "@/lib/engine";
import { config } from "@/lib/config";
import { requireSessionOrKey } from "@/lib/api";
import { taskModule } from "@/lib/agent-tasks";

export const dynamic = "force-dynamic";

/**
 * Setup packet for wiring one agent's Grok Bot to the console:
 *   GET /api/agents/<slug>/grokbot?key=…            JSON
 *   GET /api/agents/<slug>/grokbot?key=…&format=md  Markdown to paste into the Bot (instructions) and INFRASTRUCTURE.md
 * Secrets are never printed — only the env var names and whether each is set.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const g = requireSessionOrKey(req); if (g) return g;
  const { slug } = await ctx.params;
  const a = getAgent(slug);
  if (!a || !/^[a-z0-9-]{1,40}$/.test(slug)) return NextResponse.json({ error: "Unknown agent" }, { status: 404 });
  const base = config.publicBaseUrl.replace(/\/$/, "");
  const S = slug.toUpperCase().replace(/-/g, "_");
  const m = MINDS[slug];
  const tasks = await taskModule(slug);
  const packet = {
    agent: { slug, name: a.name, role: a.role, email: a.email, telegram: a.telegram || null },
    engineNow: engineFor(slug), engineLabel: ENGINE_LABEL[engineFor(slug)], chatEnabled: chatEnabled(slug),
    env: {
      [`GROKBOT_WEBHOOK_URL_${S}`]: grokbotConfigured(slug) ? "set" : "MISSING — the Bot routine's webhook URL",
      [`GROKBOT_WEBHOOK_KEY_${S}`]: process.env[`GROKBOT_WEBHOOK_KEY_${S}`] ? "set" : "optional — bearer the routine expects",
      [`GROKBOT_CALLBACK_KEY_${S}`]: grokbotCallbackKey(slug) ? "set" : "MISSING — the key the Bot presents to the MCP server (or set GROKBOT_CALLBACK_KEY for the fleet)",
      [`TELEGRAM_BOT_TOKEN_${S}`]: process.env[`TELEGRAM_BOT_TOKEN_${S}`] ? "set" : "MISSING — needed for Telegram cut-over (webhook on, Hermes polling off)",
      [`AGENT_ENGINE_${S}`]: process.env[`AGENT_ENGINE_${S}`] || "(unset: grokbot once the webhook URL exists, else claude)",
    },
    mcp: { url: `${base}/api/mcp/${slug}`, auth: `Authorization: Bearer <GROKBOT_CALLBACK_KEY_${S}>`, tools: ["load_mind", "open_jobs", "get_job", "thread_history", "reply_to_team", "append_vault_note", ...toolsFor(slug, slug === "arnold" ? ["save_top_ten"] : []).map((t) => t.name)] },
    restReply: { url: `${base}/api/agents/${slug}/reply`, auth: `Authorization: Bearer <GROKBOT_CALLBACK_KEY_${S}>` },
    telegramSetup: `${base}/api/telegram/${slug}/setup?key=<team key>`,
    mind: { core: m?.core || [], folders: m?.folders || [] },
    schedules: tasks ? Object.values(tasks.TASKS).map((t) => ({ id: t.id, title: t.title, times: t.times.map((x) => `${x.hour}:${String(x.minute).padStart(2, "0")}`), days: t.days, summary: t.summary })) : [],
    wakeBody: { event: "blp.job", jobId: 123, agent: slug, who: "Brigham", via: "console|telegram|schedule|event", message: "…", channelNote: "…", systemNote: "…", deadline: "ISO time", howToReply: "mcp reply_to_team or REST POST …/reply" },
  };
  if (req.nextUrl.searchParams.get("format") !== "md") return NextResponse.json(packet);
  const md = `# ${a.name} — Grok Bot wiring (generated ${new Date().toISOString().slice(0, 10)})

## In the Grok Bot app (Brigham or Karmel)
1. Create the Bot **${a.name} (BLP)**. Role: ${a.role}. Mailbox: ${a.email || "—"}.
2. **Plugins → Custom MCP server (Remote HTTPS)**: URL \`${packet.mcp.url}\`, header \`Authorization: Bearer <GROKBOT_CALLBACK_KEY_${S}>\` (make the key up: long random string; store it as a Bot Secret and as the console env var of the same name).
3. **Routine → trigger: Webhook**. Copy the routine's webhook URL and bearer key into the console env vars \`GROKBOT_WEBHOOK_URL_${S}\` / \`GROKBOT_WEBHOOK_KEY_${S}\`.
4. Paste the instructions below into the Bot (and the routine).
5. Test from the Agent Console chat; then Telegram cut-over: \`POST ${packet.telegramSetup}\` after Hermes' adapter for ${slug} is stopped.

## Bot instructions (paste)
You are ${a.name}, ${a.role} at Brigham Larson Pianos — one of the BLP agents that share one brain, the BLP Knowledge Vault. Your persona, rules and memory live in the vault, not in this app: on every wake call the MCP tool \`load_mind\` first and follow what it returns (SOUL, AGENTS.md conventions, AGENT_STYLE, STATUS, memory, coaching notes). Never guess a fact you can look up with a tool; if a fact isn't in the vault or the apps, say "could not verify" and where it would be.

When the BLP Agent Console wakes you by webhook, the body is a job: \`jobId\`, who wrote, where from (\`via\`: console chat, Telegram, a scheduled task, or a Sales Console event), the \`message\`, a \`channelNote\` (how to format for that channel), an optional \`systemNote\` (task-mode instructions) and a \`deadline\`. If the body is missing, call \`open_jobs\`. Use \`thread_history\` when the message needs context — the thread is shared across the Agent Console, Telegram, the Store Map and the Sales App, so earlier turns may be from other teammates.

Do the work with your tools (${packet.mcp.tools.slice(6).join(", ") || "vault read"}). The only writes you may do are the approval-gated ones your tools offer (drafts for a rep to approve, approved inbox rows, the Top Ten, notes in your own vault folder) — you never send anything to a customer, never post publicly, never move a piano or change a record.

Always finish by calling \`reply_to_team\` once with the jobId and your full answer (plain text, light markdown; no tables when the channelNote says Telegram). Keep replies short and useful: recommendation first, details second. For a scheduled task, end the reply with one line \`STATUS: <one plain sentence under 160 characters>\`. Record lessons and training notes with \`append_vault_note\` in your own folder (Agents/${slug}/…), never secrets.

## Routine instruction (paste)
Trigger: Webhook. On each wake: read the webhook body as the job; if empty call open_jobs; then follow the Bot instructions and answer with reply_to_team before the deadline.

## Console env (Netlify site blpagents) — status now
${Object.entries(packet.env).map(([k, v]) => `- \`${k}\`: ${v}`).join("\n")}

## What the console does with the reply
Stores it in the shared thread (Supabase agent_messages), closes the job, sends it back to the Telegram chat it came from, posts team briefs to the team group, and for scheduled tasks writes the STATUS line to \`Agents/${slug}/STATUS.md\` in the vault.
${packet.schedules.length ? `\n## Schedules the console will wake you for\n${packet.schedules.map((t) => `- **${t.title}** (${t.id}) at ${t.times.join(", ")} Denver time, days ${t.days.join(",")} — ${t.summary}`).join("\n")}` : ""}
`;
  return new NextResponse(md, { headers: { "content-type": "text/markdown; charset=utf-8" } });
}
