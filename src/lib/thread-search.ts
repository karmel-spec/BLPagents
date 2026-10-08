/**
 * Simple thread search: text, the person who said it, and the date.
 * Used by Eddy's chat. Matching is a case-insensitive substring over the
 * message body, the speaker, their email, any card context, and the
 * America/Denver calendar date in a few common spellings.
 */

export interface SearchableMessage {
  who?: string;
  who_email?: string;
  body: string;
  created_at?: string;
  meta?: Record<string, unknown> | null;
}

function contextText(meta?: Record<string, unknown> | null): string {
  const ctx = meta?.context;
  if (!ctx || typeof ctx !== "object") return "";
  return Object.values(ctx as Record<string, unknown>)
    .filter((v): v is string => typeof v === "string")
    .join(" ");
}

function denverParts(iso?: string): { long: string; short: string; numeric: string; slash: string } {
  if (!iso) return { long: "", short: "", numeric: "", slash: "" };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { long: "", short: "", numeric: "", slash: "" };
  const tz = "America/Denver";
  const long = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "long", day: "numeric", year: "numeric" }).format(d);
  const short = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric" }).format(d);
  const numeric = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "2-digit", day: "2-digit", year: "numeric" }).format(d);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "numeric", day: "numeric", year: "numeric" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  const slash = `${get("month")}/${get("day")}/${get("year")}`;
  return { long, short, numeric, slash };
}

/** True when `raw` appears in the message text, the speaker, or the Denver date. Empty query matches everything. */
export function matchesThreadQuery(m: SearchableMessage, raw: string): boolean {
  const q = raw.trim().toLowerCase();
  if (!q) return true;
  const when = denverParts(m.created_at);
  const channel = typeof m.meta?.channel === "string" ? m.meta.channel : "";
  const blob = [m.who, m.who_email, m.body, contextText(m.meta), channel, when.long, when.short, when.numeric, when.slash]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return blob.includes(q);
}
