import { NextRequest, NextResponse } from "next/server";
import { requireSessionOrKey, jsonError } from "@/lib/api";
import { getJob } from "@/lib/agent-brain";

export const dynamic = "force-dynamic";

/** Poll one chat job: {status, reply?, tools?, error?} */
export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const guard = requireSessionOrKey(req);
  if (guard) return guard;
  try {
    const { slug, id } = await ctx.params;
    const job = await getJob(Number(id));
    if (!job || job.agent !== slug) return NextResponse.json({ error: "No such job" }, { status: 404 });
    return NextResponse.json({ status: job.status, kind: job.kind, ...(job.result || {}), error: job.error || undefined });
  } catch (err) {
    return jsonError(err);
  }
}
