import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireSessionOrKey } from "@/lib/api";
import { getAgent } from "@/lib/agents";
import { deleteRoutine, updateRoutine } from "@/lib/routines";

export const dynamic = "force-dynamic";

/** PATCH {…fields, enabled} → edit / pause; DELETE → remove. */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const g = requireSessionOrKey(req); if (g) return g;
  const { slug, id } = await ctx.params;
  if (!getAgent(slug)) return NextResponse.json({ error: "Unknown agent" }, { status: 404 });
  try {
    const r = await updateRoutine(Number(id), slug, (await req.json().catch(() => ({}))) as Record<string, unknown>);
    if (!r) return NextResponse.json({ error: "No such routine" }, { status: 404 });
    return NextResponse.json({ routine: r });
  } catch (e) { return jsonError(e, 400); }
}
export async function DELETE(req: NextRequest, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const g = requireSessionOrKey(req); if (g) return g;
  const { slug, id } = await ctx.params;
  if (!getAgent(slug)) return NextResponse.json({ error: "Unknown agent" }, { status: 404 });
  try { return NextResponse.json({ deleted: await deleteRoutine(Number(id), slug) }); }
  catch (e) { return jsonError(e); }
}
