/**
 * Mailboxes for the cloud agents (Clara first; Melody next). One shape, two backends:
 *
 *  - @brighamlarsonpianos.com (Workspace): Gmail REST acting as the mailbox through the
 *    service account's domain-wide delegation (`sub:` JWT). Threads, labels, filters.
 *  - brighamlarson@gmail.com / brighamlarsonpianos@gmail.com (personal Gmail): IMAP + SMTP
 *    over a Google App Password (env BRIGHAM_GMAIL_APP_PASSWORD / BLP_GMAIL_APP_PASSWORD).
 *    IMAP can search, read headers, archive and label — it cannot create Gmail filters.
 *
 * Every mailbox-changing function here is only reachable from agent tools that first pass
 * the approval gate (agent-approvals.ts). Nothing in this file deletes or trashes mail, and
 * the only sends are an approved `mailto:` unsubscribe and a forward to a BLP mailbox.
 */
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { createTransport } from "nodemailer";
import { getGoogleTokenAs } from "./google-auth";

export const WORKSPACE_DOMAIN = "brighamlarsonpianos.com";
export const BLP_MAILBOX_DOMAINS = [WORKSPACE_DOMAIN, "gmail.com"]; // gmail.com only for the two personal accounts below
const PERSONAL: Record<string, string> = {
  "brighamlarson@gmail.com": (process.env.BRIGHAM_GMAIL_APP_PASSWORD || "").replace(/\s+/g, ""),
  "brighamlarsonpianos@gmail.com": (process.env.BLP_GMAIL_APP_PASSWORD || "").replace(/\s+/g, ""),
};
const GMAIL_MODIFY = ["https://www.googleapis.com/auth/gmail.modify"];
const GMAIL_SETTINGS = ["https://www.googleapis.com/auth/gmail.settings.basic"]; // delegated separately; only filters need it
const GAPI = "https://gmail.googleapis.com/gmail/v1/users/me";

export type Backend = "workspace" | "imap";
export function backendFor(user: string): Backend {
  const u = user.toLowerCase();
  if (u.endsWith(`@${WORKSPACE_DOMAIN}`)) return "workspace";
  if (PERSONAL[u] !== undefined) return "imap";
  throw new Error(`${user} is not a BLP mailbox this runtime can open`);
}
export function mailboxConfigured(user: string): { ok: boolean; why?: string } {
  const u = user.toLowerCase();
  if (u.endsWith(`@${WORKSPACE_DOMAIN}`)) return process.env.GOOGLE_PRIVATE_KEY ? { ok: true } : { ok: false, why: "GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY not set" };
  if (u in PERSONAL) return PERSONAL[u] ? { ok: true } : { ok: false, why: `${u} needs its Google App Password in Netlify (${u.startsWith("brighamlarson@") ? "BRIGHAM_GMAIL_APP_PASSWORD" : "BLP_GMAIL_APP_PASSWORD"})` };
  return { ok: false, why: `${user} is not a BLP mailbox` };
}

export interface MailHit { id: string; threadId: string; date: string; from: string; fromAddress: string; subject: string; unread: boolean; labels: string[]; snippet?: string }
export interface MailHeaders { id: string; threadId: string; date: string; from: string; fromAddress: string; replyTo: string; to: string; subject: string; listUnsubscribe: string; listUnsubscribePost: string; precedence: string; autoSubmitted: string; messageId: string; labels: string[]; text: string }

const isoOf = (d: string | Date | undefined) => (d ? (d instanceof Date ? d : new Date(d)) : new Date()).toISOString();
const addressOf = (v: string) => (v.match(/<([^>]+)>/)?.[1] || v).trim().toLowerCase();

// ------------------------------------------------------------------ Workspace (Gmail REST)
async function gapi(user: string, path: string, init: RequestInit = {}, scopes: string[] = GMAIL_MODIFY) {
  const token = await getGoogleTokenAs(user, scopes);
  const r = await fetch(`${GAPI}/${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers || {}) }, cache: "no-store", signal: AbortSignal.timeout(25000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`Gmail ${init.method || "GET"} ${path.split("?")[0]} as ${user}: ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}
type GMsg = { id: string; threadId: string; labelIds?: string[]; snippet?: string; internalDate?: string; payload?: { headers?: { name: string; value: string }[]; mimeType?: string; body?: { data?: string }; parts?: GMsg["payload"][] } };
const hdr = (m: GMsg, n: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value || "";
function bodyText(p: GMsg["payload"] | undefined, depth = 0): string {
  if (!p || depth > 6) return "";
  if (p.mimeType === "text/plain" && p.body?.data) return Buffer.from(p.body.data, "base64url").toString("utf8");
  for (const part of p.parts || []) { const t = bodyText(part, depth + 1); if (t) return t; }
  if (p.mimeType === "text/html" && p.body?.data) return Buffer.from(p.body.data, "base64url").toString("utf8").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return "";
}
const labelCache = new Map<string, Map<string, string>>();
async function wsLabels(user: string): Promise<Map<string, string>> {
  const hit = labelCache.get(user);
  if (hit) return hit;
  const j = (await gapi(user, "labels")) as { labels: { id: string; name: string }[] };
  const m = new Map((j.labels || []).map((l) => [l.name, l.id]));
  labelCache.set(user, m);
  return m;
}
async function wsLabelId(user: string, name: string, create: boolean): Promise<string> {
  const m = await wsLabels(user);
  const hit = m.get(name);
  if (hit) return hit;
  if (!create) throw new Error(`Label "${name}" does not exist in ${user}`);
  const j = (await gapi(user, "labels", { method: "POST", body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }) })) as { id: string };
  m.set(name, j.id);
  return j.id;
}

// ------------------------------------------------------------------ Personal (IMAP)
async function withImap<T>(user: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const pass = PERSONAL[user.toLowerCase()];
  if (!pass) throw new Error(mailboxConfigured(user).why);
  const c = new ImapFlow({ host: "imap.gmail.com", port: 993, secure: true, auth: { user, pass }, logger: false });
  await c.connect();
  try { return await fn(c); } finally { await c.logout().catch(() => {}); }
}
/** Translate the small Gmail-query subset the agents use into IMAP search; pass the rest through Gmail's X-GM-RAW. */
function imapCriteria(q: string): Record<string, unknown> {
  const crit: Record<string, unknown> = {};
  let rest = q;
  rest = rest.replace(/\bis:unread\b/g, () => { crit.seen = false; return ""; });
  rest = rest.replace(/\bnewer_than:(\d+)d\b/g, (_, d) => { crit.since = new Date(Date.now() - Number(d) * 864e5); return ""; });
  rest = rest.replace(/\bfrom:(\S+)/g, (_, f) => { crit.from = f.replace(/^"|"$/g, ""); return ""; });
  rest = rest.replace(/\bsubject:("[^"]+"|\S+)/g, (_, s) => { crit.subject = s.replace(/^"|"$/g, ""); return ""; });
  rest = rest.replace(/\bin:inbox\b/g, "").trim();
  if (rest) crit.gmailRaw = rest;
  return crit;
}

// ------------------------------------------------------------------ public API
/** Search a mailbox. Workspace: full Gmail query syntax. Personal: is:unread, newer_than:Nd, from:, subject:, plus raw Gmail search. */
export async function searchMail(user: string, query: string, max = 25): Promise<MailHit[]> {
  max = Math.min(100, Math.max(1, max));
  if (backendFor(user) === "workspace") {
    const list = (await gapi(user, `messages?q=${encodeURIComponent(query)}&maxResults=${max}`)) as { messages?: { id: string; threadId: string }[] };
    const out: MailHit[] = [];
    for (const m of list.messages || []) {
      const g = (await gapi(user, `messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)) as GMsg;
      const from = hdr(g, "From");
      out.push({ id: g.id, threadId: g.threadId, date: new Date(Number(g.internalDate || 0)).toISOString(), from, fromAddress: addressOf(from), subject: hdr(g, "Subject") || "(no subject)", unread: (g.labelIds || []).includes("UNREAD"), labels: g.labelIds || [], snippet: g.snippet });
    }
    return out;
  }
  return withImap(user, async (c) => {
    const lock = await c.getMailboxLock("INBOX");
    try {
      const uids = ((await c.search(imapCriteria(query || "in:inbox"), { uid: true })) as number[]).sort((a, b) => b - a).slice(0, max);
      const out: MailHit[] = [];
      if (!uids.length) return out;
      for await (const m of c.fetch(uids, { uid: true, envelope: true, flags: true, internalDate: true, labels: true }, { uid: true })) {
        const f = m.envelope?.from?.[0];
        const from = f ? `${f.name ? `${f.name} ` : ""}<${f.address}>` : "(unknown)";
        out.push({ id: String(m.uid), threadId: String(m.uid), date: isoOf(m.internalDate), from, fromAddress: (f?.address || "").toLowerCase(), subject: m.envelope?.subject || "(no subject)", unread: !m.flags?.has("\\Seen"), labels: Array.from(m.labels || []) });
      }
      return out.sort((a, b) => b.date.localeCompare(a.date));
    } finally { lock.release(); }
  });
}

/** Headers (incl. List-Unsubscribe) + the first ~4k chars of text for one message. Read-only. */
export async function getMessage(user: string, id: string): Promise<MailHeaders> {
  if (backendFor(user) === "workspace") {
    const g = (await gapi(user, `messages/${id}?format=full`)) as GMsg;
    const from = hdr(g, "From");
    return { id: g.id, threadId: g.threadId, date: new Date(Number(g.internalDate || 0)).toISOString(), from, fromAddress: addressOf(from), replyTo: hdr(g, "Reply-To"), to: hdr(g, "To"), subject: hdr(g, "Subject"), listUnsubscribe: hdr(g, "List-Unsubscribe"), listUnsubscribePost: hdr(g, "List-Unsubscribe-Post"), precedence: hdr(g, "Precedence"), autoSubmitted: hdr(g, "Auto-Submitted"), messageId: hdr(g, "Message-ID"), labels: g.labelIds || [], text: bodyText(g.payload).slice(0, 4000) };
  }
  return withImap(user, async (c) => {
    const lock = await c.getMailboxLock("INBOX");
    try {
      const m = await c.fetchOne(id, { uid: true, source: true, flags: true, internalDate: true, labels: true }, { uid: true });
      if (!m || !m.source) throw new Error(`Message ${id} not found in ${user} INBOX`);
      const p = await simpleParser(m.source);
      const h = (n: string) => { const v = p.headers.get(n.toLowerCase()); return v == null ? "" : typeof v === "string" ? v : Array.isArray(v) ? v.map(String).join(", ") : (v as { text?: string }).text || String(v); };
      const from = p.from?.text || "";
      return { id: String(m.uid), threadId: String(m.uid), date: isoOf(m.internalDate || p.date), from, fromAddress: (p.from?.value?.[0]?.address || "").toLowerCase(), replyTo: p.replyTo?.text || "", to: p.to && !Array.isArray(p.to) ? p.to.text : "", subject: p.subject || "", listUnsubscribe: h("list-unsubscribe"), listUnsubscribePost: h("list-unsubscribe-post"), precedence: h("precedence"), autoSubmitted: h("auto-submitted"), messageId: p.messageId || "", labels: Array.from(m.labels || []), text: (p.text || (p.html ? String(p.html).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ") : "")).slice(0, 4000) };
    } finally { lock.release(); }
  });
}

/** Archive (remove from INBOX) and/or add a label. Never trashes. */
export async function labelAndArchive(user: string, ids: string[], opts: { addLabel?: string; archive?: boolean }): Promise<{ changed: number }> {
  ids = ids.filter(Boolean).slice(0, 500);
  if (!ids.length) return { changed: 0 };
  if (backendFor(user) === "workspace") {
    const addLabelIds = opts.addLabel ? [await wsLabelId(user, opts.addLabel, true)] : [];
    const removeLabelIds = opts.archive ? ["INBOX"] : [];
    for (let i = 0; i < ids.length; i += 100) {
      await gapi(user, "messages/batchModify", { method: "POST", body: JSON.stringify({ ids: ids.slice(i, i + 100), addLabelIds, removeLabelIds }) });
    }
    return { changed: ids.length };
  }
  return withImap(user, async (c) => {
    if (opts.addLabel) { try { await c.mailboxCreate(opts.addLabel); } catch { /* exists */ } }
    const lock = await c.getMailboxLock("INBOX");
    try {
      const uids = ids.map(Number).filter((n) => Number.isFinite(n) && n > 0);
      if (opts.addLabel) await c.messageCopy(uids, opts.addLabel, { uid: true });
      if (opts.archive) await c.messageMove(uids, "[Gmail]/All Mail", { uid: true });
      return { changed: ids.length };
    } finally { lock.release(); }
  });
}

/** Workspace only: a Gmail filter (label + skip inbox). Personal Gmail cannot create filters over IMAP. */
export async function createFilter(user: string, query: string, opts: { addLabel?: string; archive?: boolean; forwardTo?: string }): Promise<{ id: string }> {
  if (backendFor(user) !== "workspace") throw new Error(`${user} is a personal Gmail — filters cannot be created over IMAP (Manual — Brigham)`);
  if (opts.forwardTo && !opts.forwardTo.toLowerCase().endsWith(`@${WORKSPACE_DOMAIN}`) && !(opts.forwardTo.toLowerCase() in PERSONAL)) throw new Error("Filters may only forward to BLP mailboxes");
  const action: Record<string, unknown> = {};
  if (opts.addLabel) action.addLabelIds = [await wsLabelId(user, opts.addLabel, true)];
  if (opts.archive) action.removeLabelIds = ["INBOX"];
  if (opts.forwardTo) action.forward = opts.forwardTo;
  const j = (await gapi(user, "settings/filters", { method: "POST", body: JSON.stringify({ criteria: { query }, action }) }, GMAIL_SETTINGS)) as { id: string };
  return { id: j.id };
}

export type UnsubResult = { method: "one-click" | "https-get" | "mailto" | "none"; status: string; detail: string };
/**
 * Unsubscribe exactly per Clara's SOUL: the message's own List-Unsubscribe header, one attempt.
 *  1. https + List-Unsubscribe-Post → one POST "List-Unsubscribe=One-Click"
 *  2. https only → one GET; anything beyond a confirmation = "manual"
 *  3. mailto only → one empty email from the mailbox to exactly that address (allowed only when `allowMailto`)
 *  4. nothing → "none" (archive/label instead)
 */
export async function unsubscribe(user: string, id: string, allowMailto: boolean): Promise<UnsubResult> {
  const h = await getMessage(user, id);
  const targets = Array.from(h.listUnsubscribe.matchAll(/<([^>]+)>/g)).map((m) => m[1].trim());
  const https = targets.find((t) => /^https:\/\//i.test(t));
  const mailto = targets.find((t) => /^mailto:/i.test(t));
  const senderDomain = h.fromAddress.split("@")[1] || "";
  if (https) {
    const host = new URL(https).hostname;
    const lookalike = senderDomain && !host.endsWith(senderDomain) && !senderDomain.endsWith(host.split(".").slice(-2).join(".")) && !/\b(list-manage|mailchimp|hubspot|sendgrid|customer\.io|iterable|klaviyo|constantcontact|salesforce|marketo|emailinboundprocessing|ontraport|msgsndr|beehiiv|substack|convertkit|activehosted|sendinblue|brevo|rs6|cmail|mailgun|sparkpost|intercom-mail|pandadoc|zapier|tailscale|openai|anthropic|google)\b/i.test(host);
    if (lookalike) return { method: "none", status: "manual", detail: `unsubscribe host ${host} does not match sender ${senderDomain} — Brigham decides (possible spam)` };
    if (/one-click/i.test(h.listUnsubscribePost)) {
      const r = await fetch(https, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click", redirect: "manual", signal: AbortSignal.timeout(20000) }).catch((e) => ({ status: 0, statusText: String(e) } as Response));
      const ok = r.status >= 200 && r.status < 300;
      return { method: "one-click", status: ok ? `HTTP ${r.status}` : `HTTP ${r.status} — manual — Brigham`, detail: https.slice(0, 120) };
    }
    const r = await fetch(https, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(20000) }).catch((e) => ({ status: 0, statusText: String(e), text: async () => "" } as Response));
    const body = r.status ? (await r.text().catch(() => "")).slice(0, 20000).toLowerCase() : "";
    const confirmed = /unsubscribed|you have been removed|successfully|no longer receive|removed from/.test(body);
    const needsForm = /<form|type="password"|log in|sign in|enter your email/.test(body) && !confirmed;
    return { method: "https-get", status: confirmed ? `HTTP ${r.status} confirmed` : needsForm ? `HTTP ${r.status} — page needs a form/login — manual — Brigham` : `HTTP ${r.status} — unconfirmed — manual — Brigham`, detail: https.slice(0, 120) };
  }
  if (mailto) {
    if (!allowMailto) return { method: "none", status: "mailto only — not sent (this agent never emails)", detail: mailto.slice(0, 120) };
    const u = new URL(mailto);
    const to = u.pathname;
    const subject = u.searchParams.get("subject") || "unsubscribe";
    if (backendFor(user) !== "imap") throw new Error("mailto unsubscribe is only wired for the personal Gmail accounts");
    const t = createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass: PERSONAL[user.toLowerCase()] } });
    await t.sendMail({ from: user, to, subject, text: "" });
    return { method: "mailto", status: "sent 1 empty email", detail: `${to} subject "${subject}"` };
  }
  return { method: "none", status: "no List-Unsubscribe header — archive/label instead", detail: "" };
}

/** Forward one message to a BLP mailbox (never outside). */
export async function forwardInternal(user: string, id: string, to: string, note: string): Promise<{ ok: true }> {
  const t = to.toLowerCase();
  if (!t.endsWith(`@${WORKSPACE_DOMAIN}`) && !(t in PERSONAL)) throw new Error(`Forwarding is limited to BLP mailboxes (got ${to})`);
  const h = await getMessage(user, id);
  const subject = /^fwd?:/i.test(h.subject) ? h.subject : `Fwd: ${h.subject}`;
  const body = `${note}\n\n---------- Forwarded message ----------\nFrom: ${h.from}\nDate: ${h.date}\nSubject: ${h.subject}\nTo: ${h.to}\n\n${h.text}`;
  if (backendFor(user) === "workspace") {
    const raw = Buffer.from([`From: ${user}`, `To: ${to}`, `Subject: ${subject.replace(/[\r\n]+/g, " ")}`, "Content-Type: text/plain; charset=utf-8", "", body].join("\r\n")).toString("base64url");
    await gapi(user, "messages/send", { method: "POST", body: JSON.stringify({ raw }) });
    return { ok: true };
  }
  const tr = createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass: PERSONAL[user.toLowerCase()] } });
  await tr.sendMail({ from: user, to, subject, text: body });
  return { ok: true };
}
