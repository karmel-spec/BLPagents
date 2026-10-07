/**
 * The approval gate. An agent may change a mailbox (archive, label, filter,
 * unsubscribe, forward) only for a (proposal, row) a human approved by number.
 * The vault's `Agents/<slug>/inbox-cleanup/APPROVALS.md` stays the human record;
 * this table (public.agent_approvals) is what the code checks, and the console /
 * chat write to both.
 */
import { supa } from "./supa";

export interface Approval { id: number; agent: string; mailbox: string; proposal: string; row_no: number; approved_by: string; approved_by_email: string; words: string; approved_at: string; expires_at: string; executed_at: string | null; executed_job: number | null; result: string | null }

export async function findApproval(agent: string, proposal: string, rowNo: number): Promise<Approval | null> {
  const rows = await supa<Approval[]>(`agent_approvals?agent=eq.${encodeURIComponent(agent)}&proposal=eq.${encodeURIComponent(proposal)}&row_no=eq.${rowNo}&limit=1`);
  return rows[0] || null;
}

/** Throws unless the row is approved, unexpired, and for this mailbox. Returns the approval. */
export async function requireApproval(agent: string, mailbox: string, proposal: string | undefined, rowNo: number | undefined): Promise<Approval> {
  if (!proposal || !rowNo) throw new Error("No approval given — mailbox changes need the proposal file name and the approved row number");
  const a = await findApproval(agent, proposal, rowNo);
  if (!a) throw new Error(`Row ${rowNo} of ${proposal} is not approved (not in agent_approvals) — propose it, don't do it`);
  if (a.mailbox.toLowerCase() !== mailbox.toLowerCase()) throw new Error(`Row ${rowNo} was approved for ${a.mailbox}, not ${mailbox}`);
  if (new Date(a.expires_at).getTime() < Date.now()) throw new Error(`Row ${rowNo} approval expired on ${a.expires_at.slice(0, 10)} — ask again`);
  return a;
}

export async function recordApproval(x: { agent: string; mailbox: string; proposal: string; rowNo: number; by: string; byEmail?: string; words: string }): Promise<Approval> {
  const rows = await supa<Approval[]>("agent_approvals?on_conflict=agent,proposal,row_no", {
    method: "POST",
    headers: { Prefer: "return=representation,resolution=merge-duplicates" },
    body: JSON.stringify({ agent: x.agent, mailbox: x.mailbox, proposal: x.proposal, row_no: x.rowNo, approved_by: x.by, approved_by_email: x.byEmail || "", words: x.words, approved_at: new Date().toISOString(), expires_at: new Date(Date.now() + 14 * 864e5).toISOString() }),
  });
  return rows[0];
}

export async function markExecuted(id: number, jobId: number | undefined, result: string): Promise<void> {
  await supa(`agent_approvals?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ executed_at: new Date().toISOString(), executed_job: jobId ?? null, result: result.slice(0, 2000) }) });
}

export async function listApprovals(agent: string, limit = 200): Promise<Approval[]> {
  return supa<Approval[]>(`agent_approvals?agent=eq.${encodeURIComponent(agent)}&order=approved_at.desc&limit=${limit}`);
}

/** Parse "approve 1-10, 12 · skip 7" style replies into row numbers (approve only). */
export function parseRowList(text: string): number[] {
  const m = text.match(/approve\s+([\d\s,\-–]+)/i) || text.match(/^([\d\s,\-–]+)$/);
  if (!m) return [];
  const out = new Set<number>();
  for (const part of m[1].split(/[,\s]+/).filter(Boolean)) {
    const r = part.match(/^(\d+)[\-–](\d+)$/);
    if (r) { for (let i = Number(r[1]); i <= Number(r[2]) && i - Number(r[1]) < 500; i++) out.add(i); }
    else if (/^\d+$/.test(part)) out.add(Number(part));
  }
  return Array.from(out).sort((a, b) => a - b);
}
