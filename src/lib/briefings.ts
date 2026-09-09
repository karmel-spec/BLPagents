import { googleGet } from "./google-auth";

/**
 * Daily briefings — the agents' morning work product.
 *
 * Every brief lands as a Google Doc in the "BLP Shop Briefs" Drive folder
 * (shared read-only with the console's service account):
 *   - Shop Manager Briefing / Admin Morning Briefing — written 7:44 AM daily
 *     by the Store Map Apps Script (BLPStoreMap/apps-script/DailyReport.gs)
 *   - Sales / Marketing / Operations Briefing — Hermes cron output published
 *     by scripts/publish-briefs.mjs on the agents' Mac
 * The console only reads: newest doc per brief, plus section anchors so the
 * Admin brief can be split between Ivory and Melody.
 */

const DRIVE_SCOPE = ["https://www.googleapis.com/auth/drive.readonly"];
const DOCS_SCOPE = ["https://www.googleapis.com/auth/documents.readonly"];

export const BRIEFS_FOLDER_ID = process.env.BLP_BRIEFS_FOLDER_ID || "1v_nxxfENOxS9BEXlFevQMFDOwTik_J3a";

export interface BriefSpec {
  key: string;
  title: string;
  /** Doc name prefix (the generators use "<title> — <date> · N to review"). */
  prefix: string;
  /** Agent slugs who own this brief. Admin brief has two owners (see sections). */
  agents: string[];
  schedule: string;
  /** For split briefs: section-title keywords → owning agent. Unmatched → "shared". */
  sectionOwners?: { agent: string; match: RegExp }[];
  /**
   * The generator's fixed section titles, used when the Docs API can't be
   * read (anchors then fall back to the whole doc). Keep in step with
   * BLPStoreMap/apps-script/DailyReport.gs.
   */
  staticSections?: string[];
}

export const BRIEF_SPECS: BriefSpec[] = [
  { key: "shop", title: "Shop Manager Briefing", prefix: "Shop Manager Briefing", agents: ["chris"], schedule: "7:44 AM daily" },
  {
    key: "admin",
    title: "Admin Morning Briefing",
    prefix: "Admin Morning Briefing",
    agents: ["ivory", "melody"],
    schedule: "7:44 AM daily",
    // Ivory = tuning/admin/money; Melody = front desk & customer coordination.
    sectionOwners: [
      { agent: "ivory", match: /time-clock|payment|admin/i },
      { agent: "melody", match: /media|delivery|address|sold|completed/i },
    ],
    staticSections: [
      "🛠 Time-clock fixes waiting",
      "💰 Admin & payments",
      "📷 Media",
      "📍 No delivery address found",
      "✓ Sold / completed — awaiting delivery",
      "📚 Deep dives",
    ],
  },
  { key: "sales", title: "Sales Briefing", prefix: "Sales Briefing", agents: ["arnold"], schedule: "8:00 AM Mon–Sat" },
  { key: "marketing", title: "Marketing Briefing", prefix: "Marketing Briefing", agents: ["marcus"], schedule: "8:30 AM Mon–Sat" },
  { key: "operations", title: "Operations Briefing", prefix: "Operations Briefing", agents: ["lindsay"], schedule: "9:00 AM Mon–Fri" },
  { key: "brigham", title: "Brigham's Daily Brief", prefix: "Brigham's Daily Brief", agents: ["clara"], schedule: "7:00 AM Mon–Fri" },
];

export interface BriefSection {
  title: string;
  href: string;
  owner: string; // agent slug or "shared"
}

export interface BriefDoc {
  id: string;
  name: string;
  href: string;
  modifiedAt: string;
  /** Parsed from "· N to review" in the title, if present. */
  toReview: number | null;
  isToday: boolean;
}

export interface Briefing extends BriefSpec {
  doc: BriefDoc | null;
  sections: BriefSection[];
}

type DriveFile = { id: string; name: string; modifiedTime: string; webViewLink: string };

/** Newest doc per brief spec from the last few days of the folder. */
async function listRecentDocs(): Promise<DriveFile[]> {
  const since = new Date(Date.now() - 4 * 86400_000).toISOString();
  const q = `'${BRIEFS_FOLDER_ID}' in parents and trashed=false and modifiedTime > '${since}'`;
  const params = new URLSearchParams({
    q,
    orderBy: "modifiedTime desc",
    pageSize: "60",
    fields: "files(id,name,modifiedTime,webViewLink)",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const data = await googleGet(`https://www.googleapis.com/drive/v3/files?${params}`, DRIVE_SCOPE);
  return (data.files || []) as DriveFile[];
}

/** Headings (with anchor ids) of a Google Doc, in document order. */
async function docHeadings(docId: string): Promise<{ title: string; headingId: string }[]> {
  const fields = "body.content(paragraph(paragraphStyle(namedStyleType,headingId),elements(textRun(content))))";
  const doc = await googleGet(`https://docs.googleapis.com/v1/documents/${docId}?fields=${encodeURIComponent(fields)}`, DOCS_SCOPE);
  const out: { title: string; headingId: string }[] = [];
  for (const el of doc.body?.content || []) {
    const p = el.paragraph;
    if (!p) continue;
    const style = p.paragraphStyle?.namedStyleType || "";
    if (!style.startsWith("HEADING") || !p.paragraphStyle?.headingId) continue;
    const title = (p.elements || []).map((e: any) => e.textRun?.content || "").join("").trim();
    if (title) out.push({ title, headingId: p.paragraphStyle.headingId });
  }
  return out;
}

/** Same calendar day in Mountain time (the shop's clock). */
function isTodayMountain(iso: string): boolean {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date(iso)) === fmt.format(new Date());
}

export async function readBriefings(): Promise<Briefing[]> {
  const files = await listRecentDocs();
  const out: Briefing[] = [];

  for (const spec of BRIEF_SPECS) {
    const file = files.find((f) => f.name.startsWith(spec.prefix)); // newest first
    let doc: BriefDoc | null = null;
    let sections: BriefSection[] = [];
    if (file) {
      const m = file.name.match(/·\s*(\d+)\s*to review/);
      doc = {
        id: file.id,
        name: file.name,
        href: file.webViewLink || `https://docs.google.com/document/d/${file.id}/edit`,
        modifiedAt: file.modifiedTime,
        toReview: m ? Number(m[1]) : null,
        isToday: isTodayMountain(file.modifiedTime),
      };
      if (spec.sectionOwners) {
        try {
          const heads = await docHeadings(file.id);
          sections = heads
            .filter((h) => !/jump to a section/i.test(h.title))
            .map((h) => ({
              title: h.title,
              href: `https://docs.google.com/document/d/${file.id}/edit#heading=${h.headingId}`,
              owner: spec.sectionOwners!.find((o) => o.match.test(h.title))?.agent || "shared",
            }));
        } catch {
          /* Docs API unavailable (not enabled / not shared) — fall through to static titles */
        }
        if (sections.length === 0 && spec.staticSections) {
          sections = spec.staticSections.map((title) => ({
            title,
            href: doc!.href,
            owner: spec.sectionOwners!.find((o) => o.match.test(title))?.agent || "shared",
          }));
        }
      }
    }
    out.push({ ...spec, doc, sections });
  }
  return out;
}
