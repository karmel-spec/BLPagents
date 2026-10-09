import { NextRequest, NextResponse } from "next/server";
import { getAgent } from "@/lib/agents";
import { callbackKeyOk } from "@/lib/engine";
import { completeGrokJob, openGrokJobs } from "@/lib/grokbot-relay";
import { hasTeamKey, jsonError } from "@/lib/api";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";
export const maxDuration = 26;

/**
 * Plain-HTTP side door for a Grok Bot without MCP (curl from its computer):
 *   GET  /api/agents/<slug>/reply                 → jobs still waiting for an answer
 *   POST /api/agents/<slug>/reply {jobId, reply}  → deliver the answer (same as the MCP tool reply_to_team)
 * Auth: Authorization: Bearer <GROKBOT_CALLBACK_KEY_<SLUG>> (or x-blp-key).
 */
const SLUG = /^[a-z0-9-]{1,40}$/;
function guard(req: NextRequest, slug: string): NextResponse | null {
  if (!SLUG.test(slug) || !getAgent(slug)) return NextResponse.json({ error: "Unknown agent" }, { status: 404 });
  if (!callbackKeyOk(slug, req.headers.get("authorization") || req.headers.get("x-blp-key")) && !(Boolean(config.accessKey) && hasTeamKey(req))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return null;
}
export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = guard(req, slug); if (g) return g;
  try {
    const jobs = await openGrokJobs(slug);
    return NextResponse.json({ open: jobs.map((j) => ({ jobId: j.id, kind: j.kind, who: j.who, message: j.payload?.wakeMessage || j.payload?.message || "", deadline: j.payload?.deadline || null })) });
  } catch (err) { return jsonError(err); }
}
export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const g = guard(req, slug); if (g) return g;
  try {
    const b = (await req.json().catch(() => ({}))) as { jobId?: number | string; reply?: string };
    const r = await completeGrokJob(slug, Number(b.jobId), String(b.reply || ""), "rest");
    return NextResponse.json({ ok: true, ...r });
  } catch (err) { return jsonError(err, 400); }
}
