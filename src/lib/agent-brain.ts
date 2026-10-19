/**
 * In-app agent runner (Brigham, 2026-10-07): an agent answers in the browser
 * with NO Hermes and no Mac. Its mind is read live from the BLP Knowledge
 * Vault repo (SOUL, AGENTS, STATUS, MEMORY, coaching, rules…), the
 * conversation is the Claude API with a few read-mostly tools, and every
 * message lands in the same `agent_messages` table the Store Map chat uses,
 * so one thread per agent is shared by every app and device.
 *
 * Replies take longer than a Netlify request allows, so each message is a
 * job (agent_jobs): the API inserts it, kicks the background function, and
 * the page polls until it's done. Locally (next dev) the job runs inline.
 *
 * 2026-10-08 (Brigham): the fleet moves to Grok Bots. Ivory, Chris and Eddy
 * have their own bridges (grokbot.ts, grokbot-bridge.ts). Every other agent
 * uses the fleet-wide relay (src/lib/engine.ts + grokbot-relay.ts): engine
 * "grokbot" wakes the agent's Grok Bot and lets it answer through the MCP
 * server at /api/mcp/<slug>; engine "claude" is this file's own runner, kept
 * as the fallback for agents whose Bot isn't wired yet.
 */
import { getFile, listDir, vaultConfigured } from "./vault-github";
import { supa, supaConfigured } from "./supa";
import { matchesThreadQuery } from "./thread-search";
import { config } from "./config";
import { backendFor, createFilter, forwardInternal, getMessage, labelAndArchive, mailboxConfigured, searchMail, unsubscribe } from "./mail";
import { markExecuted, requireApproval } from "./agent-approvals";
import { isGrokbotSlug } from "./grokbot-shared";
import { engineFor, grokbotConfigured } from "./engine";

/** Which mailboxes each agent may open (its own credential, per AGENT_ARCHITECTURE Rule 1). */
const MAILBOXES: Record<string, string[]> = {
  clara: ["brigham@brighamlarsonpianos.com", "brighamlarson@gmail.com"],
  melody: ["info@brighamlarsonpianos.com", "karmel@brighamlarsonpianos.com"],
};
const MAIL_TOOLS = ["search_mail", "read_message", "archive_mail", "create_mail_filter", "unsubscribe_sender", "forward_to_teammate"];

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.AGENT_MODEL || "claude-sonnet-5-5";
const SALES_APP = (process.env.SALES_APP_URL || "https://blpsalesapp.netlify.app").replace(/\/$/, "");
const SALES_KEY = process.env.BLP_ARNOLD_ACCESS_KEY || "";

export const brainConfigured = () => Boolean(ANTHROPIC_KEY && vaultConfigured() && supaConfigured());

/** Which vault files make up each agent's working mind (loaded every message) and where the rest lives (read on demand). */
export const MINDS: Record<string, { core: string[]; folders: string[]; tools: string[]; intro: string }> = {
  arnold: {
    core: [
      "AGENTS.md", "AGENT_STYLE.md",
      "Agents/arnold/SOUL.md", "Agents/arnold/AGENTS.md", "Agents/arnold/STATUS.md", "Agents/arnold/MEMORY.md", "Agents/arnold/NEXT_SESSION.md",
      "Agents/arnold/kb/coaching-feedback.md", "Agents/arnold/kb/SALES_STRATEGY_RULES.md", "Agents/arnold/kb/brigham-voice-quickref.md",
      "Agents/arnold/kb/BRIGHAM_DRAFT_PREFLIGHT_V2.md", "Agents/arnold/kb/VOICE_PATTERNS.md", "Agents/arnold/KB.md",
    ],
    folders: ["Agents/arnold", "Agents/arnold/kb", "kb"],
    tools: ["read_vault_file", "list_vault_folder", "search_leads", "lookup_lead", "save_drafts"],
    intro: "You are chatting inside the BLP Agent Console (a web app), not Telegram. The person typing is a BLP teammate. You can read any vault file on demand, look leads up in the Sales Console, and save drafts there for a rep to approve — you can never send anything to a customer.",
  },
};
// Clarence (slug `clara`; renamed from Clara 2026-10-13, male persona).
MINDS.clara = {
  core: ["AGENTS.md", "AGENT_STYLE.md", "kb/team/roster.md", "Agents/clara/SOUL.md", "Agents/clara/MEMORY.md", "Agents/clara/STATUS.md", "Agents/clara/BRIEF_SOURCES.md", "Agents/clara/INBOX_CLEANUP.md", "Agents/clara/ENGAGEMENT_IDEAS.md", "Agents/clara/TRAINING_PLAN.md"],
  folders: ["Agents/clara", "kb"],
  tools: ["read_vault_file", "list_vault_folder", "search_leads", "lookup_lead", "quickbooks_lookup", ...MAIL_TOOLS],
  intro: "You are chatting inside the BLP Agent Console (a web app), not Telegram. The person typing is a BLP teammate. You can read any vault file on demand, look up customers in the Sales Console, and look customers up in QuickBooks (read-only: invoices, balances, payments; admin-side only, never shared with the shop). You cannot send email from here — if something needs Brigham's inbox, say so and describe what you'd do.",
};
MINDS.lindsay = {
  core: ["AGENTS.md", "AGENT_STYLE.md", "kb/team/roster.md", "Agents/lindsay/SOUL.md", "Agents/lindsay/OPEN_ASKS.md", "Agents/lindsay/kb/INDEX.md", "Agents/lindsay/kb/karmel.md", "Agents/lindsay/kb/people.md", "Agents/lindsay/kb/fleet.md", "Agents/lindsay/kb/reports.md", "Agents/lindsay/kb/email-triage.md", "Agents/lindsay/kb/vault-map.md"],
  folders: ["Agents/lindsay", "Agents/lindsay/kb", "kb"],
  tools: ["read_vault_file", "list_vault_folder", "search_leads", "lookup_lead", "quickbooks_lookup", "fleet_health"],
  intro: "You are chatting inside the BLP Agent Console (a web app), not Telegram. The person typing is a BLP teammate, usually Karmel. You can read any vault file on demand, look up customers in the Sales Console, and look customers up in QuickBooks (read-only: invoices, balances, payments). QuickBooks figures are admin-side only — never pass prices or balances to the shop.",
};
// Fallback mind. When CHRIS_GROKBOT_WEBHOOK_URL and CHRIS_GROKBOT_WEBHOOK_KEY are set,
// Chris's chats are forwarded to Cristofori GrokBot and this mind is not called.
// Never add KB/shop-economics-CONFIDENTIAL.md here.
MINDS.chris = {
  core: ["AGENTS.md", "AGENT_STYLE.md", "kb/team/roster.md", "Agents/chris/SOUL.md", "Agents/chris/SHOP_SOURCES.md", "Agents/chris/KB/INDEX.md", "Agents/chris/KB/history-shop-app.md", "Agents/chris/training-briefs/chris-telegram-training-brief.md", "Agents/chris/KB/domain-notes-and-roster.md", "Agents/chris/KB/phase-time-standards.md", "Agents/chris/KB/training-and-timeclock.md", "Agents/chris/KB/store-map-readme.md"],
  folders: ["Agents/chris", "Agents/chris/KB", "kb"],
  tools: ["read_vault_file", "list_vault_folder", "search_shop_pianos"],
  intro: "You are chatting inside the BLP Agent Console (a web app), not Telegram. You are Chris (Cristofori Larson), shop manager for Brigham Larson Pianos — this in-app mind answers only when the Cristofori GrokBot bridge is not configured. The person typing is a BLP teammate, often Brigham or the shop team. You can read any vault file on demand and look pianos up on the live Store Map (phase, location, queue, notes). You draft only: you never move a piano's stage, spot, or status, never message customers, vendors, or the team, and never handle pay, hours, hiring, or delivery dates. Say \"could not verify\" rather than guessing. Keep a serial number in every line that names a piano.",
};
MINDS.marcus = {
  core: ["AGENTS.md", "AGENT_STYLE.md", "Agents/marcus/SOUL.md", "Agents/marcus/AGENTS.md", "Agents/marcus/IDENTITY.md", "Agents/marcus/MEMORY.md", "Agents/marcus/STATUS.md", "Agents/marcus/LESSONS.md", "Agents/marcus/kb/KB001-brand-voice.md", "Agents/marcus/kb/KB002-youtube-strategy.md", "Agents/marcus/kb/KB003-social-platforms.md", "Agents/marcus/kb/KB004-content-templates.md", "Agents/marcus/kb/KB005-marketing-metrics.md", "Agents/marcus/kb/KB006-lead-sources.md", "Agents/marcus/kb/KB007-marketing-engine-app.md"],
  folders: ["Agents/marcus", "Agents/marcus/kb", "kb"],
  tools: ["read_vault_file", "list_vault_folder", "search_shop_pianos"],
  intro: "You are chatting inside the BLP Agent Console (a web app), not Telegram or the Marketing app. The person typing is a BLP teammate. You can read any vault file on demand and look up for-sale pianos on the live Store Map (price, location, status). Copy you write here is for the person to paste or file in the Marketing app's Approvals — nothing publishes from this chat.",
};
// Ivory has no Claude mind. She answers only through Ivory Grok Bot (src/lib/grokbot.ts).
/**
 * Agents whose in-app chat is the Eddy/Chris Grok Bot bridge and who have no Claude mind.
 * Eddy (slug `ed`) is answered by Eddy Bot only — never MINDS / Claude / Hermes.
 * Ivory is separate: isGrokbotSlug, her own webhook payload, and a Supabase write-back.
 */
MINDS.melody = {
  core: ["AGENTS.md", "AGENT_STYLE.md", "kb/team/roster.md", "Agents/melody/SOUL.md", "Agents/melody/AGENTS.md", "Agents/melody/IDENTITY.md", "Agents/melody/STATUS.md", "Agents/melody/MEMORY.md", "Agents/melody/INBOX_CLEANUP.md", "Agents/melody/customer-service-playbook.md"],
  folders: ["Agents/melody", "kb"],
  tools: ["read_vault_file", "list_vault_folder", "search_leads", "lookup_lead", ...MAIL_TOOLS],
  intro: "You are chatting inside the BLP Agent Console (a web app), not Telegram. The person typing is a BLP teammate. You can read any vault file on demand, look customers up in the Sales Console, and work the info@ / karmel@ mailboxes only on approved cleanup rows (never trash, never unsubscribe business-record senders). Nothing you write here is sent to a customer.",
};
MINDS.carla = {
  core: ["AGENTS.md", "AGENT_STYLE.md", "kb/team/roster.md", "Agents/carla/SOUL.md", "Agents/carla/FLEET_SOURCES.md", "Agents/carla/STATUS.md"],
  folders: ["Agents/carla", "kb"],
  tools: ["read_vault_file", "list_vault_folder"],
  intro: "You are chatting inside the BLP Agent Console (a web app), not Telegram. The person typing is a BLP teammate, usually Karmel. You manage the vehicles (fleet = vehicles at BLP). You can read any vault file on demand; the FLEET LOG sheet is your source of truth — say when a fact isn't in it.",
};
/**
 * Every agent with a vault folder gets a console mind (Brigham, 2026-10-14: "give all the
 * agents a console mind"). The Grok Bots write these folders themselves (README, SOUL,
 * IDENTITY, MEMORY, LESSONS, STATUS, SKILLS, ROUTINES…). Agents listed in MINDS above keep
 * their hand-tuned entry; everyone else gets a generated one: the standard files that exist
 * in Agents/<folder>/ (looked up live, cached), plus tools picked by role. Add a new agent by
 * adding its slug here (folder name only when it differs from the slug).
 */
export const VAULT_AGENTS: Record<string, string> = {
  addie: "addie", anne: "anne", brandy: "brandy", cody: "cody", collette: "collette", collin: "collin", desie: "desie",
  eunice: "eunice", howie: "howie", hugh: "hugh", lee: "lee", moe: "moe", monte: "monte", morgan: "morgan", penny: "penny",
  rajeesh: "rajeesh", reese: "reese", regis: "regis", ricardo: "ricardo", sam: "sam", sharie: "sharie", shirley: "shirley",
  tori: "tori", tray: "tray", walter: "walter", warren: "warren", yolanda: "yolanda",
};
/** Standard files a Bot keeps in its folder, in the order they are loaded (GROKBOT_MEMORY.md is a raw export — read on demand, not every turn). */
const STANDARD_FILES = ["README.md", "SOUL.md", "IDENTITY.md", "MEMORY.md", "LESSONS.md", "STATUS.md", "SKILLS.md", "ROUTINES.md", "TODO.md", "SHOP_REFERENCE.md", "FLEET_SOURCES.md"];
const FINANCE = new Set(["monte", "anne", "collette", "regis", "sam", "penny", "connie"]);
const SHOP_OR_MARKETING = new Set(["howie", "tray", "moe", "tori", "desie", "sharie", "yolanda", "lee", "addie", "brandy", "collin", "rajeesh", "reese", "warren"]);
const SALES_LOOKUP = new Set(["walter", "collette", "reese", "tori", "moe", "warren", "lee", "hugh"]);
export type MindSpec = { core: string[]; folders: string[]; tools: string[]; intro: string; generated?: boolean };
export function mindSpec(slug: string): MindSpec | undefined {
  if (MINDS[slug]) return MINDS[slug];
  const folder = VAULT_AGENTS[slug];
  if (!folder) return undefined;
  const tools = ["read_vault_file", "list_vault_folder"];
  if (FINANCE.has(slug)) tools.push("quickbooks_lookup");
  if (SHOP_OR_MARKETING.has(slug)) tools.push("search_shop_pianos");
  if (SALES_LOOKUP.has(slug)) tools.push("search_leads", "lookup_lead");
  const name = slug.charAt(0).toUpperCase() + slug.slice(1);
  return {
    generated: true,
    core: ["AGENTS.md", "AGENT_STYLE.md", "kb/team/roster.md", ...STANDARD_FILES.map((f) => `Agents/${folder}/${f}`)],
    folders: [`Agents/${folder}`, "kb"],
    tools,
    intro: `You are chatting inside the BLP Agent Console (a web app), not Telegram. You are ${name}; your persona, memory and rules are the files below, which your own Grok Bot keeps in the BLP Knowledge Vault. The person typing is a BLP teammate. You can read any vault file on demand${tools.includes("quickbooks_lookup") ? ", look customers up in QuickBooks (read-only, admin-side only — never share figures with the shop)" : ""}${tools.includes("search_shop_pianos") ? ", look pianos up on the live Store Map" : ""}${tools.includes("search_leads") ? ", look customers up in the Sales Console" : ""}. You draft and recommend; you never send, post, pay, or change a record from here — say what a human should click instead. Say "could not verify" rather than guess.`,
  };
}
export const GROKBOT_CHAT_ONLY = new Set(["ed"]);
/** An agent can be chatted with when it has an in-app mind, a per-agent bridge (Ivory/Chris/Eddy), or a Grok Bot wired through the fleet relay. */
export const chatEnabled = (slug: string) => Boolean(mindSpec(slug)) || GROKBOT_CHAT_ONLY.has(slug) || isGrokbotSlug(slug) || grokbotConfigured(slug);
/** Is the engine that will answer this agent configured on this deployment? (Bridged agents answer this in their own routes.) */
export const agentReady = (slug: string) => (engineFor(slug) === "grokbot" ? supaConfigured() && vaultConfigured() : engineFor(slug) === "bridge" ? supaConfigured() : brainConfigured() && Boolean(mindSpec(slug)));
/** Tool definitions an engine may use for this agent (chat set + task-only extras). */
export function toolsFor(slug: string, extra: string[] = []): { name: string; description: string; input_schema: Record<string, unknown> }[] {
  const m = mindSpec(slug);
  return Array.from(new Set([...(m?.tools || ["read_vault_file", "list_vault_folder"]), ...extra])).map((t) => TOOL_DEFS[t]).filter(Boolean);
}

// ---------------------------------------------------------------- mind (vault)
const mindCache = new Map<string, { at: number; text: string }>();
const MIND_TTL = 5 * 60_000;

/**
 * Speed (Brigham, 2026-10-14: replies felt slow): the mind is ~13 GitHub reads. Netlify
 * background functions start cold, so the in-memory cache rarely helps there — a copy
 * also lives in Supabase `agent_mind_cache` (same 5-minute TTL), one fast read instead.
 */
async function sharedMind(slug: string): Promise<string | null> {
  try {
    const rows = await supa<{ mind: string; cached_at: string }[]>(`agent_mind_cache?slug=eq.${encodeURIComponent(slug)}&select=mind,cached_at&limit=1`);
    const r = rows[0];
    if (r && Date.now() - Date.parse(r.cached_at) < MIND_TTL) return r.mind;
  } catch { /* cache only */ }
  return null;
}
async function shareMind(slug: string, text: string, files: number): Promise<void> {
  try { await supa("agent_mind_cache?on_conflict=slug", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ slug, mind: text, files, cached_at: new Date().toISOString() }) }); } catch { /* cache only */ }
}

export async function loadMind(slug: string, force = false): Promise<string> {
  const m = mindSpec(slug);
  if (!m) throw new Error(`No in-app mind defined for ${slug}`);
  const hit = mindCache.get(slug);
  if (!force && hit && Date.now() - hit.at < MIND_TTL) return hit.text;
  if (!force) { const shared = await sharedMind(slug); if (shared) { mindCache.set(slug, { at: Date.now(), text: shared }); return shared; } }
  let core = m.core;
  if (m.generated) {
    // only the standard files this Bot actually keeps (one folder listing, cached with the mind)
    try { const entries = await listDir(m.folders[0]); if (entries) { const have = new Set(entries.map((e) => e.path)); core = m.core.filter((p) => !p.startsWith("Agents/") || have.has(p)); } } catch { /* fall back to trying every standard file */ }
  }
  const parts = await Promise.all(core.map(async (p) => {
    try { const f = await getFile(p); return f ? `\n\n===== ${p} =====\n${f.content.trim()}` : `\n\n===== ${p} =====\n(missing in the vault)`; }
    catch (e) { return `\n\n===== ${p} =====\n(could not load: ${e instanceof Error ? e.message : String(e)})`; }
  }));
  const text = parts.join("");
  mindCache.set(slug, { at: Date.now(), text });
  await shareMind(slug, text, m.core.length);
  return text;
}

// ---------------------------------------------------------------- tools
const TOOL_DEFS: Record<string, { name: string; description: string; input_schema: Record<string, unknown> }> = {
  read_vault_file: { name: "read_vault_file", description: "Read one file from the BLP Knowledge Vault repo (your kb, shared kb/, procedures, pricing…). Path like 'Agents/arnold/kb/brigham-exemplar-threads.md' or 'kb/pricing/…'.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  list_vault_folder: { name: "list_vault_folder", description: "List files in a vault folder, e.g. 'kb' or 'Agents/arnold/kb'.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  search_leads: { name: "search_leads", description: "Find leads in the Sales Console by name, phone, email or headline text. Returns up to 10 compact matches with ids.", input_schema: { type: "object", properties: { query: { type: "string" }, status: { type: "string", description: "optional statusBucket filter: new|active|snoozed|dormant|won|lost" } }, required: ["query"] } },
  lookup_lead: { name: "lookup_lead", description: "Full detail for one lead (contact, notes, timeline of texts/emails/calls, pending drafts) by its id from search_leads.", input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  search_shop_pianos: { name: "search_shop_pianos", description: "Look pianos up on the live Store Map (the Piano Log): serial, make/model, owner, location/slot, shop phase and phases done, queue position, track, price, wait/phase notes. Query matches serial, summary, owner or location; empty query = the shop queue in order.", input_schema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } } } },
  mark_listing_posted: { name: "mark_listing_posted", description: "Record that a KSL or Facebook Marketplace listing is LIVE (Kelsy posted it). The Marketing app stamps the Piano Log (KSL DATE col BY / FB column), closes the approval, records the link, and turns the Week-tab slot green. Call once per listing; repeating with the same link is a harmless no-op; a different link the same day is refused (409). Marcus only.", input_schema: { type: "object", required: ["stock_number", "target", "listing_url", "posted_at"], properties: { stock_number: { type: "string", description: "Piano serial / stock number, e.g. 31849" }, target: { type: "string", enum: ["ksl", "fb"], description: "ksl = KSL Classifieds, fb = Facebook Marketplace" }, listing_url: { type: "string", description: "The live listing URL" }, posted_at: { type: "string", description: "ISO 8601 timestamp of the post, e.g. 2026-10-19T17:05:00Z" }, initials: { type: "string", description: "Poster initials for the Piano Log (2–4 letters), e.g. KLS for Kelsy" } } } },
  save_top_ten: { name: "save_top_ten", description: "TASK MODE ONLY. Save the day's ranked Top Ten (leads a human should reach TODAY) to the Sales Console so Brigham's screen shows it. Call once per morning brief with exactly the ranked list you report.", input_schema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { rank: { type: "number" }, leadId: { type: "string" }, leadName: { type: "string" }, reason: { type: "string", description: "one line: why today + next move" } }, required: ["rank", "leadId", "leadName", "reason"] } } }, required: ["items"] } },
  fleet_health: { name: "fleet_health", description: "Fleet oversight (Lindsay): every live BLP agent's engine (Grok Bot relay / bridge / console mind), whether it is configured, its last cloud job (status, time, error), open jobs, and each agent's routines with their last run and summary. Use this instead of any Hermes cron check — Hermes is retired.", input_schema: { type: "object", properties: {} } },
  quickbooks_lookup: { name: "quickbooks_lookup", description: "Look a customer up in QuickBooks Online (read-only, via the Sales Console): matching customers with balance, their invoices (number, date, total, balance, line items, link) and optionally payments. Query by name or email. Admin-side only — never share these figures with the shop.", input_schema: { type: "object", properties: { query: { type: "string", description: "customer name or email" }, payments: { type: "boolean", description: "also list payments" } }, required: ["query"] } },
  save_drafts: { name: "save_drafts", description: "Save follow-up drafts on a lead in the Sales Console for a rep to approve and send (the only write you may do). Never claims to have sent anything.", input_schema: { type: "object", properties: { leadId: { type: "string" }, drafts: { type: "array", items: { type: "object", properties: { channel: { type: "string", enum: ["sms", "email"] }, subject: { type: "string" }, body: { type: "string" }, note: { type: "string" } }, required: ["channel", "body"] } } }, required: ["leadId", "drafts"] } },
};

let leadsCache: { at: number; leads: Record<string, unknown>[] } | null = null;
export async function allLeads(): Promise<Record<string, unknown>[]> {
  if (leadsCache && Date.now() - leadsCache.at < 60_000) return leadsCache.leads;
  if (!SALES_KEY) throw new Error("BLP_ARNOLD_ACCESS_KEY not set — the console can't read the Sales Console");
  const r = await fetch(`${SALES_APP}/api/leads`, { headers: { "x-blp-key": SALES_KEY }, signal: AbortSignal.timeout(25000), cache: "no-store" });
  if (!r.ok) throw new Error(`Sales Console /api/leads ${r.status}`);
  const j = (await r.json()) as { leads: Record<string, unknown>[] };
  leadsCache = { at: Date.now(), leads: j.leads || [] };
  return leadsCache.leads;
}
const s = (v: unknown) => (v == null ? "" : String(v));
export const compactLead = (l: Record<string, unknown>) => ({ id: l.id, name: l.name, status: l.status, statusBucket: l.statusBucket, rep: l.effectiveRep, headline: l.headline, leadType: l.leadType, pianoType: l.pianoType, value: l.value, phone: l.phoneDialable, email: l.emailClean, lastContact: l.lastContact, daysSinceContact: l.daysSinceContact, score: l.score });

const APPROVAL_INPUT = { proposal: { type: "string", description: "approved proposal file name, e.g. '2026-09-10 proposal.md'" }, row: { type: "number", description: "the approved row number" } };
Object.assign(TOOL_DEFS, {
  search_mail: { name: "search_mail", description: "Search one of your mailboxes (read-only). Gmail query syntax for Workspace mailboxes; for personal Gmail use is:unread, newer_than:Nd, from:, subject:. Returns up to `max` compact hits (id, from, subject, date, unread, labels).", input_schema: { type: "object", properties: { mailbox: { type: "string" }, query: { type: "string" }, max: { type: "number" } }, required: ["mailbox", "query"] } },
  read_message: { name: "read_message", description: "Read one message's headers (From, Reply-To, List-Unsubscribe, List-Unsubscribe-Post…) and the first part of its text. Read-only.", input_schema: { type: "object", properties: { mailbox: { type: "string" }, id: { type: "string" } }, required: ["mailbox", "id"] } },
  archive_mail: { name: "archive_mail", description: "APPROVED ROWS ONLY. Add a label and/or remove messages from the inbox (archive — never trash). Requires the approved proposal + row number.", input_schema: { type: "object", properties: { mailbox: { type: "string" }, ids: { type: "array", items: { type: "string" } }, addLabel: { type: "string" }, archive: { type: "boolean" }, ...APPROVAL_INPUT }, required: ["mailbox", "ids", "proposal", "row"] } },
  create_mail_filter: { name: "create_mail_filter", description: "APPROVED ROWS ONLY. Create a Gmail filter (label and/or skip inbox, optional forward to a BLP mailbox) — Workspace mailboxes only; personal Gmail cannot (say 'Manual — Brigham').", input_schema: { type: "object", properties: { mailbox: { type: "string" }, query: { type: "string" }, addLabel: { type: "string" }, archive: { type: "boolean" }, forwardTo: { type: "string" }, ...APPROVAL_INPUT }, required: ["mailbox", "query", "proposal", "row"] } },
  unsubscribe_sender: { name: "unsubscribe_sender", description: "APPROVED ROWS ONLY. Unsubscribe using exactly the message's own List-Unsubscribe header (one-click POST, single GET, or — personal Gmail only — one empty mailto email). Never a reply. Returns the HTTP status; anything not 2xx/confirmed is 'manual — Brigham'.", input_schema: { type: "object", properties: { mailbox: { type: "string" }, id: { type: "string", description: "a message id from that sender" }, ...APPROVAL_INPUT }, required: ["mailbox", "id", "proposal", "row"] } },
  forward_to_teammate: { name: "forward_to_teammate", description: "APPROVED ROWS ONLY. Forward one message to a BLP mailbox (@brighamlarsonpianos.com) with a one-line note. Never to anyone outside BLP.", input_schema: { type: "object", properties: { mailbox: { type: "string" }, id: { type: "string" }, to: { type: "string" }, note: { type: "string" }, ...APPROVAL_INPUT }, required: ["mailbox", "id", "to", "proposal", "row"] } },
});

export interface ToolCtx { slug: string; jobId?: number }
function ownMailbox(ctx: ToolCtx, mailbox: string): string {
  const mb = s(mailbox).toLowerCase();
  if (!(MAILBOXES[ctx.slug] || []).includes(mb)) throw new Error(`${ctx.slug} may not open ${mb} — allowed: ${(MAILBOXES[ctx.slug] || []).join(", ") || "none"}`);
  const c = mailboxConfigured(mb);
  if (!c.ok) throw new Error(c.why || "mailbox not configured");
  backendFor(mb);
  return mb;
}

export async function runTool(name: string, input: Record<string, unknown>, ctx: ToolCtx = { slug: "" }): Promise<string> {
  try {
    if (name === "search_mail") {
      const mb = ownMailbox(ctx, s(input.mailbox));
      const hits = await searchMail(mb, s(input.query), Number(input.max) || 25);
      return hits.length ? JSON.stringify(hits.map((h) => ({ id: h.id, date: h.date.slice(0, 16), from: h.from, subject: h.subject, unread: h.unread, labels: h.labels.filter((l) => !/^CATEGORY_/.test(l)) }))) : "No messages match.";
    }
    if (name === "read_message") {
      const mb = ownMailbox(ctx, s(input.mailbox));
      const m = await getMessage(mb, s(input.id));
      return JSON.stringify({ ...m, text: m.text.slice(0, 2500) });
    }
    if (name === "archive_mail" || name === "create_mail_filter" || name === "unsubscribe_sender" || name === "forward_to_teammate") {
      const mb = ownMailbox(ctx, s(input.mailbox));
      const a = await requireApproval(ctx.slug, mb, s(input.proposal), Number(input.row));
      let result = "";
      if (name === "archive_mail") {
        const ids = Array.isArray(input.ids) ? (input.ids as unknown[]).map(s) : [];
        const r = await labelAndArchive(mb, ids, { addLabel: input.addLabel ? s(input.addLabel) : undefined, archive: input.archive !== false });
        result = `${r.changed} messages ${input.archive !== false ? "archived" : "labeled"}${input.addLabel ? ` + label "${s(input.addLabel)}"` : ""}`;
      } else if (name === "create_mail_filter") {
        const r = await createFilter(mb, s(input.query), { addLabel: input.addLabel ? s(input.addLabel) : undefined, archive: input.archive !== false, forwardTo: input.forwardTo ? s(input.forwardTo) : undefined });
        result = `filter ${r.id} created for '${s(input.query)}'`;
      } else if (name === "unsubscribe_sender") {
        const r = await unsubscribe(mb, s(input.id), backendFor(mb) === "imap");
        result = `unsubscribe ${r.method}: ${r.status} (${r.detail})`;
      } else {
        await forwardInternal(mb, s(input.id), s(input.to), s(input.note || "Forwarded by Clarence per approved cleanup row."));
        result = `forwarded message ${s(input.id)} to ${s(input.to)}`;
      }
      await markExecuted(a.id, ctx.jobId, result);
      return `Row ${a.row_no} (${a.proposal}, approved by ${a.approved_by}): ${result}. Log this line in inbox-cleanup/LOG.md.`;
    }
    if (name === "read_vault_file") { const f = await getFile(s(input.path)); return f ? f.content.slice(0, 60000) : `Not found: ${s(input.path)}`; }
    if (name === "list_vault_folder") { const e = await listDir(s(input.path)); return e ? e.map((x) => `${x.type === "dir" ? "📁" : "📄"} ${x.path}${x.type === "file" ? ` (${x.size} bytes)` : ""}`).join("\n") : `No folder: ${s(input.path)}`; }
    if (name === "search_leads") {
      const q = s(input.query).toLowerCase().replace(/[^a-z0-9@. ]/g, " ").trim();
      const digits = q.replace(/\D/g, "");
      const st = s(input.status).toLowerCase();
      const hits = (await allLeads()).filter((l) => (!st || s(l.statusBucket) === st) && (
        s(l.name).toLowerCase().includes(q) || s(l.headline).toLowerCase().includes(q) || s(l.emailClean).toLowerCase().includes(q) || (digits.length >= 4 && s(l.phoneDialable).replace(/\D/g, "").includes(digits))
      )).slice(0, 10).map(compactLead);
      return hits.length ? JSON.stringify(hits) : "No leads match.";
    }
    if (name === "lookup_lead") {
      const r = await fetch(`${SALES_APP}/api/leads/${encodeURIComponent(s(input.id))}`, { headers: { "x-blp-key": SALES_KEY }, signal: AbortSignal.timeout(20000), cache: "no-store" });
      if (!r.ok) return `Lead ${s(input.id)}: ${r.status}`;
      const j = (await r.json()) as { lead: Record<string, unknown> };
      const l = j.lead;
      const tl = (l.timeline as { at: string; who: string; kind: string; text: string }[] | undefined) || [];
      return JSON.stringify({ ...compactLead(l), address: l.address, source: l.source, inquiryMethod: l.inquiryMethod, notes: l.notes, activityTimeline: s(l.activityTimeline).slice(0, 3000), closedBy: l.closedBy, timeline: tl.slice(-40).map((e) => ({ at: e.at, who: e.who, kind: e.kind, text: s(e.text).slice(0, 600) })), drafts: l.drafts });
    }
    if (name === "search_shop_pianos") {
      const r = await fetch("https://blpstoremap.netlify.app/api/data?scope=active", { signal: AbortSignal.timeout(25000), cache: "no-store" });
      if (!r.ok) return `Store Map data ${r.status}`;
      const j = (await r.json()) as { pianos: Record<string, unknown>[] };
      const q = s(input.query).toLowerCase().trim();
      const lim = Math.min(40, Math.max(1, Number(input.limit) || 15));
      const hay = (p: Record<string, unknown>) => [p.serial, p.summary, p.owner, p.location, p.make, p.model, p.phase, p.section].map(s).join(" | ").toLowerCase();
      let list = (j.pianos || []).filter((p) => p.active !== false);
      list = q ? list.filter((p) => hay(p).includes(q)) : list.filter((p) => Number(p.queuePos) > 0).sort((a, b) => Number(a.queuePos) - Number(b.queuePos));
      const out = list.slice(0, lim).map((p) => ({ serial: p.serial, piano: p.summary, owner: p.owner, location: p.location, section: p.section, phase: p.phase, phasesDone: p.phasesDone, queue: p.queuePos ? `${p.queuePos}/${p.queueTotal}` : "", track: p.track, price: p.price, status: p.status, waitNote: p.waitNote, phaseNotes: s(p.phaseNotes).slice(0, 300), scopeNotes: s(p.scopeNotes).slice(0, 300) }));
      return out.length ? JSON.stringify(out) : "No pianos match.";
    }
    if (name === "mark_listing_posted") {
      if (ctx.slug !== "marcus") return "mark_listing_posted is only available to Marcus.";
      const stock = s(input.stock_number).trim(), target = s(input.target).toLowerCase(), url = s(input.listing_url).trim(), at = s(input.posted_at).trim(), initials = s(input.initials).trim();
      if (!stock) return "stock_number is required.";
      if (target !== "ksl" && target !== "fb") return "target must be ksl or fb.";
      if (!/^https?:\/\//i.test(url)) return "listing_url must be a full http(s) URL.";
      if (!at || Number.isNaN(new Date(at).getTime())) return "posted_at must be an ISO 8601 timestamp.";
      if (initials && !/^[A-Za-z]{2,4}$/.test(initials)) return "initials must be 2–4 letters.";
      const MK = process.env.MARKETING_APP_KEY || "";
      if (!MK) return "MARKETING_APP_KEY is not set on the console — ask Karmel.";
      const r = await fetch("https://blpmarketing.netlify.app/api/listings/posted", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${MK}` }, body: JSON.stringify({ stockNumber: stock, target, listingUrl: url, postedAt: at, initials: initials || undefined, actor: "marcus-mcp" }) });
      const j: any = await r.json().catch(() => ({}));
      if (r.status === 409) return `Conflict: ${j.error}. Existing: ${JSON.stringify(j.existing || {})}`;
      if (r.status === 404) return `Unknown stock number: ${j.error}`;
      if (!r.ok) return `Marketing app said ${r.status}: ${j.error || "unknown error"}`;
      return j.status === "already" ? `Already recorded: #${j.serial} on ${String(j.target).toUpperCase()}${j.listingUrl ? ` (${j.listingUrl})` : ""}.` : `Recorded: #${j.serial} posted on ${String(j.target).toUpperCase()}${j.cell ? ` — Piano Log ${j.cell} = ${j.value}` : ""}. The Week-tab slot is green.`;
    }
    if (name === "save_top_ten") {
      const items = Array.isArray(input.items) ? (input.items as Record<string, unknown>[]).slice(0, 10).map((x, i) => ({ rank: Number(x.rank) || i + 1, leadId: s(x.leadId), leadName: s(x.leadName), reason: s(x.reason).slice(0, 400) })) : [];
      if (!items.length) return "No items given.";
      const r = await fetch(`${SALES_APP}/api/top-ten?scope=brigham`, { method: "POST", headers: { "x-blp-key": SALES_KEY, "content-type": "application/json" }, body: JSON.stringify({ items, who: "Arnold", scope: "brigham" }), signal: AbortSignal.timeout(20000) });
      const t = await r.text();
      return r.ok ? `Top Ten saved in the Sales Console: ${t.slice(0, 200)}` : `Top Ten save failed (${r.status}): ${t.slice(0, 300)}`;
    }
    if (name === "fleet_health") {
      const { AGENTS, isRetired } = await import("./agents");
      const { engineStatus } = await import("./grokbot-relay");
      const { listRoutines } = await import("./routines");
      const slugs = AGENTS.filter((a) => !isRetired(a) && chatEnabled(a.slug)).map((a) => a.slug);
      const eng = await engineStatus(slugs, brainConfigured());
      const out: Record<string, unknown> = {};
      for (const slug of slugs) {
        let routines: unknown[] = [];
        try { routines = (await listRoutines(slug)).map((r) => ({ id: r.id, title: r.title, time: `${r.hour}:${String(r.minute).padStart(2, "0")}`, days: r.days, enabled: r.enabled, lastRunAt: r.last_run_at, lastStatus: r.last_status, lastSummary: r.last_summary })); } catch { /* table may be empty */ }
        out[slug] = { ...eng[slug], routines };
      }
      return JSON.stringify({ checkedAt: new Date().toISOString(), note: "Hermes is retired (2026-10-14): judge health from these records, never from a Mac heartbeat or `hermes cron list`.", agents: out });
    }
    if (name === "quickbooks_lookup") {
      if (!SALES_KEY) return "QuickBooks lookup unavailable: BLP_ARNOLD_ACCESS_KEY not set on the console.";
      const r = await fetch(`${SALES_APP}/api/qbo/lookup?q=${encodeURIComponent(s(input.query))}${input.payments ? "&payments=1" : ""}`, { headers: { "x-blp-key": SALES_KEY }, signal: AbortSignal.timeout(25000), cache: "no-store" });
      const t = await r.text();
      if (!r.ok) return `QuickBooks lookup failed (${r.status}): ${t.slice(0, 200)}`;
      try { const j = JSON.parse(t) as { connected?: boolean; hint?: string; matches?: unknown[] }; if (j.connected === false) return `QuickBooks isn't connected yet: ${j.hint}`; if (!j.matches?.length) return `No QuickBooks customer matches "${s(input.query)}".`; } catch { /* fall through */ }
      return t.slice(0, 60000);
    }
    if (name === "save_drafts") {
      const r = await fetch(`${SALES_APP}/api/arnold/draft`, { method: "POST", headers: { "x-blp-key": SALES_KEY, "content-type": "application/json" }, body: JSON.stringify({ leadId: s(input.leadId), drafts: input.drafts }), signal: AbortSignal.timeout(20000) });
      const t = await r.text();
      return r.ok ? `Saved for approval in the Sales Console: ${t.slice(0, 300)}` : `Save failed (${r.status}): ${t.slice(0, 300)}`;
    }
    return `Unknown tool ${name}`;
  } catch (e) { return `Tool error: ${e instanceof Error ? e.message : String(e)}`; }
}

// ---------------------------------------------------------------- conversation
export interface ChatMsg {
  id: number;
  agent: string;
  role: "user" | "agent";
  who: string;
  who_email: string;
  body: string;
  run_id: string | null;
  created_at: string;
  reply_to?: number | null;
  meta?: Record<string, unknown> | null;
}

export async function history(slug: string, limit = 40): Promise<ChatMsg[]> {
  const rows = await supa<(Omit<ChatMsg, "role"> & { role: string })[]>(`agent_messages?agent=eq.${encodeURIComponent(slug)}&order=created_at.desc&limit=${limit}`);
  return rows.reverse().map((row) => ({ ...row, role: row.role === "assistant" ? "agent" : row.role === "user" ? "user" : "agent" }));
}

/**
 * Search one agent's shared thread (text, speaker, Denver date, card context).
 * Reads the newest 500 rows and filters here so a serial or a person's name
 * matches even when it lives in `meta.context` rather than the message body.
 */
export async function searchThread(slug: string, raw: string, limit = 100): Promise<ChatMsg[]> {
  const q = raw.trim().slice(0, 120);
  const cap = Math.min(200, Math.max(1, limit));
  if (q.length < 2) return [];
  const rows = await supa<ChatMsg[]>(`agent_messages?agent=eq.${encodeURIComponent(slug)}&select=id,agent,role,who,who_email,body,run_id,created_at,meta&order=created_at.desc&limit=500`);
  return rows.filter((m) => matchesThreadQuery(m, q)).slice(0, cap).reverse();
}

async function anthropic(body: Record<string, unknown>, maxTokens = 2500): Promise<{ content: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[]; stop_reason: string; usage?: Record<string, number> }> {
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY is not set on the console");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, ...body }),
    signal: AbortSignal.timeout(110_000),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

/** Where a turn came from. The agent is told, so it knows who it heard from and where the reply lands. */
export type Via = "console" | "telegram" | "schedule" | "event";

export interface AskOptions {
  via?: Via;
  /** One paragraph describing the channel (e.g. "Telegram group 'BLP Sales Team'"). Replaces the console intro's first sentence. */
  channelNote?: string;
  /** Extra system instructions (task mode: what to do, how to report). */
  systemNote?: string;
  /** Tool-use round trips allowed (chat 8; scheduled tasks far more). */
  maxTurns?: number;
  /** Extra tool names (from TOOL_DEFS) beyond the agent's chat set — task mode only. */
  extraTools?: string[];
  /** Task runs start from a clean context: don't feed the shared thread back in. */
  freshContext?: boolean;
  /** Store the incoming prompt as a user row in agent_messages (false for scheduler prompts). */
  storePrompt?: boolean;
  /** Store the reply as an agent row (false when the caller stores a cleaned-up version itself, e.g. routines). */
  storeReply?: boolean;
  maxTokens?: number;
  /** Extra fields merged into the stored agent row's meta. */
  meta?: Record<string, unknown>;
}

/** One turn: the person's message in, the agent's reply out (stored both ways). */
export async function askAgent(slug: string, who: string, whoEmail: string, message: string, jobId?: number, o: AskOptions = {}): Promise<{ reply: string; tools: string[] }> {
  if (isGrokbotSlug(slug)) throw new Error(`${slug} is answered by Ivory Grok Bot, not the Claude runtime.`);
  const m = mindSpec(slug);
  if (!m) throw new Error(`No in-app mind for ${slug}`);
  const via: Via = o.via || "console";
  const mind = await loadMind(slug);
  const past = o.freshContext ? [] : await history(slug, 30);
  if (o.storePrompt !== false) await supa("agent_messages", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ agent: slug, role: "user", who, who_email: whoEmail, body: message, meta: { via, ...(o.meta || {}) } }) });
  const now = new Date().toLocaleString("en-US", { timeZone: "America/Denver", weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  // The console intro opens with "You are chatting inside the BLP Agent Console (a web app), not Telegram." — swap that for the real channel.
  const intro = o.channelNote ? m.intro.replace(/^You are chatting inside the BLP Agent Console \(a web app\), not Telegram\.\s*/, `${o.channelNote.trim()} `) : m.intro;
  const talking = via === "schedule" ? `No human is typing: this turn was started by ${who} (the cloud scheduler).` : via === "event" ? `No human is typing: this turn was raised by ${who} (an automated Sales Console event).` : `You are talking with ${who}${whoEmail ? ` (${whoEmail})` : ""}.`;
  const thread = via === "schedule" ? "" : " The thread you see is shared across the Agent Console and Telegram, so earlier turns may have come from other teammates on other devices.";
  const system = [
    { type: "text", text: `${intro}\n\nToday is ${now} (Mountain time). ${talking}${thread} Keep replies short and useful: recommendation first, details second. Use tools when a question depends on live lead facts or a file you haven't been given — never guess at facts you can look up. If something isn't in the vault or the Sales Console, say so plainly.${o.systemNote ? `\n\n${o.systemNote.trim()}` : ""}\n\nYOUR MIND (live from the BLP Knowledge Vault repo):`, cache_control: { type: "ephemeral" } },
    { type: "text", text: mind, cache_control: { type: "ephemeral" } },
  ];
  const messages: { role: "user" | "assistant"; content: unknown }[] = [
    ...past.map((p) => ({ role: (p.role === "agent" ? "assistant" : "user") as "user" | "assistant", content: p.role === "agent" ? p.body : `${p.who || "teammate"}: ${p.body}` })),
    { role: "user", content: `${who}: ${message}` },
  ];
  // Claude requires alternating roles; merge any run of same-role turns.
  const merged: typeof messages = [];
  for (const x of messages) { const last = merged[merged.length - 1]; if (last && last.role === x.role && typeof last.content === "string" && typeof x.content === "string") last.content = `${last.content}\n\n${x.content}`; else merged.push({ ...x }); }
  if (merged[0]?.role !== "user") merged.shift();
  const toolNames = Array.from(new Set([...m.tools, ...(o.extraTools || [])]));
  const tools = toolNames.map((t) => TOOL_DEFS[t]).filter(Boolean);
  const used: string[] = [];
  const maxTurns = Math.max(1, Math.min(60, o.maxTurns || 8));
  let reply = "";
  for (let i = 0; i < maxTurns; i++) {
    const last = i === maxTurns - 1;
    const out = await anthropic({ system, messages: merged, tools, ...(last ? { tool_choice: { type: "none" } } : {}) }, o.maxTokens);
    const text = out.content.filter((c) => c.type === "text").map((c) => c.text || "").join("\n").trim();
    const uses = out.content.filter((c) => c.type === "tool_use");
    if (!uses.length || out.stop_reason !== "tool_use") { reply = text; break; }
    merged.push({ role: "assistant", content: out.content });
    const results = [];
    for (const u of uses) { used.push(u.name || ""); results.push({ type: "tool_result", tool_use_id: u.id, content: (await runTool(u.name || "", u.input || {}, { slug, jobId })).slice(0, 80000) }); }
    merged.push({ role: "user", content: results });
    if (text) reply = text;
  }
  if (!reply) reply = "I looked but have nothing useful to add — ask me again with a bit more detail.";
  if (o.storeReply !== false) await supa("agent_messages", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ agent: slug, role: "agent", who: slug.charAt(0).toUpperCase() + slug.slice(1), who_email: "", body: reply, run_id: jobId ? `${via}-job:${jobId}` : null, meta: { via, model: MODEL, tools: used, to: who, ...(o.meta || {}) } }) });
  return { reply, tools: used };
}

// ---------------------------------------------------------------- jobs
export interface JobPayload {
  message?: string;
  /** Telegram turn: reply here when the job finishes. */
  telegram?: { chatId: number | string; messageId?: number; chatTitle?: string; chatType?: string };
  /** Scheduled task (kind "task"): which Arnold task to run. */
  task?: string;
  /** Who/what asked for a manual task run. */
  requestedBy?: string;
  /** Grok Bot bridge (kind "grokbot"). The reply arrives via POST /api/<agent>/reply. */
  channel?: "telegram" | "app";
  app?: string;
  sender?: { name: string; id: string };
  conversation_id?: string;
  /** Optional opener context (serial, piano, card_url, user, …). */
  context?: Record<string, string>;
  /** Extra channel description from another BLP app (Store Map, Marketing app) sent with the team key. */
  channelNote?: string;
  /** Extra instructions for this one turn (task mode note, an app's draft format…). */
  systemNote?: string;
  /** Sales Console event that created this job (draft_request, inbound_reply, team_task…). */
  event?: { name: string; postToTeam?: boolean };
  /** Team-set routine that created this job (see routines.ts). */
  routine?: { id: number; title: string; deliver: { telegramChatId?: string; teamGroup?: boolean } };
  /** Fleet relay bookkeeping (see grokbot-relay.ts). */
  engine?: "grokbot" | "claude";
  wokeAt?: string;
  deadline?: string;
  wakeMessage?: string;
}
export interface Job { id: number; agent: string; who: string; who_email: string; kind: string; payload: JobPayload; status: string; result: { reply?: string; tools?: string[]; summary?: string; telegramMessageIds?: number[]; vaultCommit?: string; engine?: string } | null; error: string | null; created_at: string; started_at: string | null; finished_at: string | null }

export const onNetlify = () => Boolean(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);

export async function createJob(agent: string, who: string, whoEmail: string, message: string, kind = "chat", payload: Omit<JobPayload, "message"> = {}): Promise<number> {
  const r = await supa<Job[]>("agent_jobs", { method: "POST", body: JSON.stringify({ agent, who, who_email: whoEmail, kind, payload: { message, ...payload } }) });
  return r[0].id;
}
export async function getJob(id: number): Promise<Job | null> {
  const r = await supa<Job[]>(`agent_jobs?id=eq.${id}&limit=1`);
  return r[0] || null;
}
/** Per-agent task runners, registered by <slug>-tasks.ts so this module needn't import them (avoids a cycle). */
type TaskRunner = (job: Job) => Promise<NonNullable<Job["result"]>>;
/** Grok Bot engine hooks: build the task prompt for the wake, and finish (deliver + STATUS line) once the Bot replies. */
export interface TaskHooks {
  prompt: (taskId: string) => Promise<{ prompt: string; systemNote: string; channelNote?: string }>;
  finish: (job: Job, reply: string, tools: string[]) => Promise<NonNullable<Job["result"]>>;
}
const taskRunners: Record<string, TaskRunner> = {};
const taskHooks: Record<string, TaskHooks> = {};
export const registerTaskRunner = (agent: string, fn: TaskRunner, hooks?: TaskHooks) => { taskRunners[agent] = fn; if (hooks) taskHooks[agent] = hooks; };
export async function loadTaskHooks(agent: string): Promise<TaskHooks> {
  await loadTaskRunner(agent);
  const h = taskHooks[agent];
  if (!h) throw new Error(`No task hooks for ${agent}`);
  return h;
}
/** How the agent is told where a turn came from — shared by both engines. */
export function channelNoteFor(job: Job, botUsername?: string): string {
  const p = job.payload || {};
  if (job.kind === "telegram" && p.telegram) {
    const t = p.telegram;
    const where = t.chatType === "private" ? "in a private Telegram chat" : `in the Telegram group "${t.chatTitle || "BLP"}"`;
    return `You are chatting on Telegram as the bot @${botUsername || `${job.agent}larsonbot`}, ${where}. The person who wrote to you is a BLP teammate. Telegram shows plain text with light formatting: no tables, keep bullets short.`;
  }
  if (job.kind === "task") return "You are running a scheduled task in the cloud runtime (no chat window).";
  if (p.event) return `This turn is an automated event from the BLP Sales Console (${p.event.name}), not a person typing. Do the work it describes with your tools and report briefly; drafts always wait for a rep's approval.`;
  return p.channelNote || "";
}
/** Agents with a scheduled-task module (src/lib/<slug>-tasks.ts). */
export const TASK_AGENTS = ["arnold", "clara"] as const;
export async function loadTaskRunner(agent: string): Promise<TaskRunner> {
  if (!taskRunners[agent]) {
    if (agent === "arnold") await import("./arnold-tasks");
    else if (agent === "clara") await import("./clara-tasks");
  }
  const fn = taskRunners[agent];
  if (!fn) throw new Error(`No task runner for ${agent}`);
  return fn;
}

export async function runJob(id: number): Promise<Job | null> {
  const claimed = await supa<Job[]>(`agent_jobs?id=eq.${id}&status=eq.pending`, { method: "PATCH", body: JSON.stringify({ status: "running", started_at: new Date().toISOString() }) });
  if (!claimed[0]) return getJob(id);
  const job = claimed[0];
  if (isGrokbotSlug(job.agent)) {
    const msg = `${job.agent} is answered by Ivory Grok Bot, not the Claude runtime.`;
    await supa(`agent_jobs?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "failed", error: msg, finished_at: new Date().toISOString() }) });
    return getJob(id);
  }
  // Eddy and Chris GrokBot replies land on their own. If something claims the job, put it back
  // so a later reply can still mark it done. Don't run the Claude mind.
  if (job.kind === "grokbot") {
    await supa(`agent_jobs?id=eq.${id}&status=eq.running`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "pending", started_at: null }) });
    return getJob(id);
  }
  const fail = async (msg: string) => {
    await supa(`agent_jobs?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "failed", error: msg, finished_at: new Date().toISOString() }) });
    if (job.kind === "telegram" && job.payload?.telegram) {
      try { const { sendMessage } = await import("./telegram"); await sendMessage(job.agent, job.payload.telegram.chatId, `Sorry — I hit an error and couldn't answer: ${msg.slice(0, 200)}`); } catch { /* best effort */ }
    }
  };
  // Fleet relay (engine "grokbot"): wake the agent's Grok Bot and leave the job running; grokbot-relay.completeGrokJob closes it when the Bot replies.
  if (engineFor(job.agent) === "grokbot") {
    try {
      const { wakeGrokBot } = await import("./grokbot-relay");
      if (job.kind === "task") {
        const hooks = await loadTaskHooks(job.agent);
        const pr = await hooks.prompt(String(job.payload?.task || ""));
        await wakeGrokBot(job, { message: pr.prompt, systemNote: pr.systemNote, channelNote: pr.channelNote });
      } else {
        if (job.kind === "telegram" && job.payload?.telegram) { try { const { typing } = await import("./telegram"); await typing(job.agent, job.payload.telegram.chatId); } catch { /* ignore */ } }
        await wakeGrokBot(job);
      }
    } catch (e) {
      await fail((e instanceof Error ? e.message : String(e)).slice(0, 1000));
    }
    return getJob(id);
  }
  try {
    let result: NonNullable<Job["result"]>;
    if (job.kind === "task") {
      result = await (await loadTaskRunner(job.agent))(job);
    } else if (job.kind === "routine") {
      const { finishRoutine, ROUTINE_NOTE } = await import("./routines");
      try {
        const out = await askAgent(job.agent, job.who || "Scheduler", "", String(job.payload?.message || ""), id, { via: "schedule", channelNote: channelNoteFor(job), systemNote: job.payload?.systemNote || ROUTINE_NOTE, freshContext: true, storePrompt: false, storeReply: false, maxTurns: 20, maxTokens: 3500, meta: { routine: job.payload?.routine?.id } });
        result = await finishRoutine(job, out.reply, true);
        result.tools = out.tools;
      } catch (e) {
        await finishRoutine(job, "", false, e instanceof Error ? e.message : String(e)).catch(() => undefined);
        throw e;
      }
    } else if (job.kind === "telegram" && job.payload?.telegram) {
      const t = job.payload.telegram;
      const { sendMessage, typing, getMe } = await import("./telegram");
      await typing(job.agent, t.chatId);
      const me = await getMe(job.agent).catch(() => null);
      const where = t.chatType === "private" ? `in a private Telegram chat` : `in the Telegram group "${t.chatTitle || "BLP"}"`;
      const channelNote = `You are chatting on Telegram as the bot @${me?.username || `${job.agent}larsonbot`}, ${where}. The person who wrote to you is a BLP teammate. Telegram shows plain text with light formatting: no tables, keep bullets short.`;
      result = await askAgent(job.agent, job.who, job.who_email, String(job.payload?.message || ""), id, { via: "telegram", channelNote, meta: { telegramChat: String(t.chatId) } });
      try { result.telegramMessageIds = await sendMessage(job.agent, t.chatId, result.reply || "…", { replyTo: t.chatType === "private" ? undefined : t.messageId }); }
      catch (e) { result.summary = `reply not delivered: ${e instanceof Error ? e.message : String(e)}`; }
    } else {
      const note = channelNoteFor(job);
      const via: Via = job.payload?.event ? "event" : "console";
      result = await askAgent(job.agent, job.who, job.who_email, String(job.payload?.message || ""), id, { via, ...(note ? { channelNote: note } : {}), ...(job.payload?.systemNote ? { systemNote: job.payload.systemNote } : {}), ...(job.payload?.event ? { meta: { event: job.payload.event.name } } : {}) });
      if (job.payload?.event?.postToTeam && result.reply) {
        try { const { sendMessage, teamChatId, telegramConfigured } = await import("./telegram"); if (telegramConfigured(job.agent) && teamChatId()) result.telegramMessageIds = await sendMessage(job.agent, teamChatId(), result.reply); }
        catch (e) { result.summary = `team post failed: ${e instanceof Error ? e.message : String(e)}`; }
      }
    }
    result.engine = "claude";
    await supa(`agent_jobs?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "done", result, finished_at: new Date().toISOString() }) });
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
    await supa(`agent_jobs?id=eq.${id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "failed", error: msg, finished_at: new Date().toISOString() }) });
    if (job.kind === "telegram" && job.payload?.telegram) {
      try { const { sendMessage } = await import("./telegram"); await sendMessage(job.agent, job.payload.telegram.chatId, `Sorry — I hit an error and couldn't answer: ${msg.slice(0, 200)}`); } catch { /* best effort */ }
    }
  }
  return getJob(id);
}
/** Fire the Netlify background function (returns 202 at once; it runs up to 15 min). */
export async function kickBackground(id: number): Promise<void> {
  const r = await fetch(`${config.publicBaseUrl.replace(/\/$/, "")}/.netlify/functions/agent-chat-run-background`, { method: "POST", redirect: "manual", headers: { "content-type": "application/json", "x-blp-key": config.accessKey }, body: JSON.stringify({ jobId: id }) });
  if (r.status >= 300) throw new Error(`Background run failed to start (${r.status}${r.status < 400 ? " redirect — middleware is gating the function path" : ""})`);
}
/** Queue a job: background on Netlify, inline in local dev. Returns the job (done) or the pending id. */
export async function dispatchJob(id: number): Promise<Job | null> {
  if (onNetlify()) { await kickBackground(id); return getJob(id); }
  return runJob(id);
}
