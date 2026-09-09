import { NextRequest, NextResponse } from "next/server";
import { gateway, type DispatchReceipt, type DispatchRecord } from "@/lib/gateway";
import { requireSession, jsonError } from "@/lib/api";
import { parseGoogleSession, SESSION_COOKIE } from "@/lib/auth";
import { getAgent } from "@/lib/agents";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const SLUG = /^[a-z0-9-]{1,40}$/;

function requester(req: NextRequest): string {
  const who = parseGoogleSession(req.cookies.get(SESSION_COOKIE)?.value);
  return who ? `${who.name} <${who.email}>` : "team (passcode)";
}

/** Hand an agent a task. Returns the run receipt; the client polls /runs/:id. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const guard = requireSession(req);
  if (guard) return guard;
  const { slug } = await ctx.params;
  if (!SLUG.test(slug) || !getAgent(slug)) return NextResponse.json({ error: "Unknown agent" }, { status: 404 });
  try {
    const body = (await req.json().catch(() => ({}))) as { input?: string };
    const input = String(body.input || "").trim();
    if (!input) return NextResponse.json({ error: "Type the task first" }, { status: 400 });
    if (input.length > 4000) return NextResponse.json({ error: "Keep a task under 4,000 characters" }, { status: 400 });
    const receipt = await gateway<DispatchReceipt>(`/agents/${slug}/runs`, {
      method: "POST",
      body: JSON.stringify({ input, requester: requester(req) }),
    });
    return NextResponse.json(receipt);
  } catch (err) {
    return jsonError(err, (err as { status?: number }).status || 502);
  }
}

/** Recent dispatches to this agent (from the gateway's audit log). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const guard = requireSession(req);
  if (guard) return guard;
  const { slug } = await ctx.params;
  if (!SLUG.test(slug)) return NextResponse.json({ error: "Unknown agent" }, { status: 404 });
  try {
    const r = await gateway<{ dispatches: DispatchRecord[] }>(`/agents/${slug}/dispatches?limit=8`);
    return NextResponse.json(r);
  } catch (err) {
    return jsonError(err, (err as { status?: number }).status || 502);
  }
}
