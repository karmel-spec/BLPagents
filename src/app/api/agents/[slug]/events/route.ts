import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getAgent } from "@/lib/agents";
import { agentReady, chatEnabled, createJob, dispatchJob } from "@/lib/agent-brain";
import { jsonError } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 26;

/**
 * Where the Sales Console's Arnold events land now that Hermes is gone
 * (draft_request, inbound_reply, followup_instruction, training_feedback,
 * team_task, watch_matched). Same contract the Hermes webhook had: JSON body,
 * GitHub-style HMAC in X-Hub-Signature-256 over the raw body with the shared
 * secret — so the Sales Console only changes ARNOLD_WEBHOOK_URL to
 *   https://blpagents.netlify.app/api/agents/arnold/events
 * Console env: SALES_EVENTS_SECRET (or ARNOLD_WEBHOOK_SECRET) = the Sales Console's ARNOLD_WEBHOOK_SECRET.
 * Each event becomes a job in the agent's thread; the engine (Grok Bot or the
 * in-app runner) works it with save_drafts etc.; team_task reports to the team group.
 */
const SLUG = /^[a-z0-9-]{1,40}$/;
const secret = () => process.env.SALES_EVENTS_SECRET || process.env.ARNOLD_WEBHOOK_SECRET || "";

function verify(raw: string, sig: string | null): boolean {
  const s = secret();
  if (!s || !sig) return false;
  const want = `sha256=${crypto.createHmac("sha256", s).update(raw).digest("hex")}`;
  const a = Buffer.from(sig); const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const ASK: Record<string, string> = {
  draft_request: "A rep clicked “Ask Arnold” on this lead. Read it with lookup_lead, then save follow-up drafts (SMS and/or email, in Brigham's voice, ghostwriter rule) with save_drafts for the rep to approve. Report in two lines what you saved and why.",
  inbound_reply: "The customer replied (text, email, web chat or a call note). Read the lead with lookup_lead, judge whether a reply is due now, and if so save the next draft with save_drafts. Never claim anything was sent. Report in one or two lines.",
  followup_instruction: "A rep left an instruction on this lead. Carry it out as drafts with save_drafts (never send), then report what you did in one or two lines.",
  training_feedback: "A rep edited or rejected one of your drafts. Work out the lesson, record it with append_vault_note in your coaching-feedback file (Agents/arnold/kb/coaching-feedback.md) in one or two dated lines, and acknowledge briefly.",
  team_task: "A teammate assigned you a task from the Sales Console. Do it with your tools and report the result; this report is posted to the BLP Sales Team group.",
  watch_matched: "A lead's watch matched. Follow the note: save a short “it's here / it's finished” draft for approval with save_drafts and report in one line.",
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  if (!SLUG.test(slug) || !getAgent(slug) || !chatEnabled(slug)) return NextResponse.json({ error: "Unknown agent" }, { status: 404 });
  const raw = await req.text();
  if (!verify(raw, req.headers.get("x-hub-signature-256"))) return NextResponse.json({ error: secret() ? "bad signature" : "SALES_EVENTS_SECRET not set on the console" }, { status: 401 });
  if (!agentReady(slug)) return NextResponse.json({ error: `${slug}'s engine is not configured on this deployment` }, { status: 503 });
  try {
    const ev = JSON.parse(raw) as { event?: string; lead?: Record<string, unknown>; leadId?: string; note?: string; source?: string; at?: string };
    const name = String(ev.event || "event").slice(0, 60);
    const lead = ev.lead || {};
    const leadLine = Object.keys(lead).length ? `LEAD: ${JSON.stringify(lead).slice(0, 4000)}` : ev.leadId ? `LEAD ID: ${ev.leadId}` : "";
    const message = [`[Sales Console event: ${name}]`, leadLine, ev.note ? `NOTE: ${String(ev.note).slice(0, 3000)}` : "", ASK[name] || "Handle this event with your tools and report briefly."].filter(Boolean).join("\n\n");
    const jobId = await createJob(slug, ev.source === "blp-sales-app" ? "Sales Console" : String(ev.source || "Sales Console").slice(0, 60), "", message, "chat", { event: { name, postToTeam: name === "team_task" } });
    const job = await dispatchJob(jobId);
    return NextResponse.json({ ok: true, jobId, status: job?.status || "pending" });
  } catch (err) { return jsonError(err, 400); }
}
export async function GET() {
  return NextResponse.json({ ok: true, hint: "POST Sales Console events here (HMAC X-Hub-Signature-256). Point the Sales Console's ARNOLD_WEBHOOK_URL at this route." });
}
