import { config } from "./config";
import { getGoogleToken, hasGoogleCreds } from "./google-auth";

/**
 * Google Sheets access layer, trimmed to what the Agent Console needs:
 * read/replace named tabs (the "Agent Status" tab of the Leads Log).
 *
 * No SDK — the service-account JWT is signed with node:crypto and all calls
 * are plain fetch, keeping the dependency footprint tiny.
 */

export class SheetsReadOnlyError extends Error {
  constructor() {
    super(
      "Sheets access unavailable: set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY, and share the Leads Log with the service account as Editor."
    );
    this.name = "SheetsReadOnlyError";
  }
}

async function api(path: string, init?: RequestInit): Promise<any> {
  const token = await getGoogleToken(["https://www.googleapis.com/auth/spreadsheets"]);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${config.sheetId}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
    }
  );
  if (res.status === 403) {
    throw new Error(
      `Google says the service account lacks permission (403). Share the Leads Log with ${config.googleClientEmail} as Editor, then retry.`
    );
  }
  if (!res.ok) throw new Error(`Sheets API ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

export function canWrite(): boolean {
  return hasGoogleCreds();
}

/** Create the tab if it doesn't exist yet. Returns true if it was created. */
export async function ensureTab(title: string): Promise<boolean> {
  if (!canWrite()) throw new SheetsReadOnlyError();
  const meta = await api("?fields=sheets.properties.title");
  if (meta.sheets?.some((s: any) => s.properties.title === title)) return false;
  await api(":batchUpdate", {
    method: "POST",
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
  });
  return true;
}

/** All rows of a named tab ([] if the tab doesn't exist). */
export async function readTab(title: string): Promise<string[][]> {
  if (!canWrite()) throw new SheetsReadOnlyError();
  try {
    const data = await api(`/values/${encodeURIComponent(title)}?majorDimension=ROWS`);
    return (data.values || []) as string[][];
  } catch (err) {
    if (err instanceof Error && err.message.includes("(400)")) return []; // no such tab yet
    throw err;
  }
}

/** Replace a named tab's contents with `rows` (creates the tab if needed). */
export async function writeTab(title: string, rows: string[][]): Promise<void> {
  if (!canWrite()) throw new SheetsReadOnlyError();
  await ensureTab(title);
  await api(`/values/${encodeURIComponent(title)}!A1:ZZ10000:clear`, { method: "POST", body: "{}" });
  await api(`/values/${encodeURIComponent(title)}!A1?valueInputOption=RAW`, {
    method: "PUT",
    body: JSON.stringify({ values: rows }),
  });
}
