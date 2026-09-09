import { NextRequest, NextResponse } from "next/server";
import { gateway, type RunStatus } from "@/lib/gateway";
import { requireSession, jsonError } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Poll a dispatched run: status, and the agent's output once completed. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string; runId: string }> }) {
  const guard = requireSession(req);
  if (guard) return guard;
  const { slug, runId } = await ctx.params;
  if (!/^[a-z0-9-]{1,40}$/.test(slug) || !/^[A-Za-z0-9_-]{1,80}$/.test(runId)) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }
  try {
    const run = await gateway<RunStatus>(`/agents/${slug}/runs/${runId}`);
    return NextResponse.json(run);
  } catch (err) {
    return jsonError(err, (err as { status?: number }).status || 502);
  }
}
