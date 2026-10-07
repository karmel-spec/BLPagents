import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireSession } from "@/lib/api";
import { parseGoogleSession, SESSION_COOKIE } from "@/lib/auth";
import { listApprovals, parseRowList, recordApproval } from "@/lib/agent-approvals";
import { chatEnabled } from "@/lib/agent-brain";

export const dynamic = "force-dynamic";

/**
 * GET  /api/agents/<slug>/approvals                       → the ledger (newest first)
 * POST /api/agents/<slug>/approvals { mailbox, proposal, rows | text, words } → record human approvals by row number
 *   rows: [1,2,3] or text: "approve 1-10, 12" — the signed-in person is the approver.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const denied = requireSession(req);
  if (denied) return denied;
  const { slug } = await params;
  try { return NextResponse.json({ approvals: await listApprovals(slug) }); } catch (e) { return jsonError(e); }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const denied = requireSession(req);
  if (denied) return denied;
  const { slug } = await params;
  if (!chatEnabled(slug)) return jsonError(new Error(`No cloud mind for ${slug}`), 404);
  try {
    const b = (await req.json()) as { mailbox?: string; proposal?: string; rows?: number[]; text?: string; words?: string };
    const rows = Array.isArray(b.rows) && b.rows.length ? b.rows.map(Number).filter(Boolean) : parseRowList(b.text || "");
    if (!b.mailbox || !b.proposal || !rows.length) return jsonError(new Error("mailbox, proposal and rows (or text like 'approve 1-10, 12') are required"), 400);
    const who = parseGoogleSession(req.cookies.get(SESSION_COOKIE)?.value);
    const by = who?.name || who?.email || "BLP team (passcode)";
    const words = (b.words || b.text || `approve ${rows.join(", ")}`).slice(0, 2000);
    const saved = [];
    for (const r of rows) saved.push(await recordApproval({ agent: slug, mailbox: b.mailbox, proposal: b.proposal, rowNo: r, by, byEmail: who?.email, words }));
    return NextResponse.json({ ok: true, approved: saved.map((a) => a.row_no), by, note: "Also copy these words into the agent's inbox-cleanup/APPROVALS.md (the human record)." });
  } catch (e) { return jsonError(e); }
}
