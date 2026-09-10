/**
 * BLP Knowledge Vault on GitHub — the source of truth for every agent's mind
 * files (IDENTITY, SOUL, AGENTS, STATUS, recipes…). The console reads and
 * writes them through the GitHub Contents API so the team can view and edit
 * by link from anywhere, and every save is a commit with an author.
 *
 * Env: VAULT_GITHUB_TOKEN (fine-grained PAT, Contents: read/write on the repo),
 *      VAULT_GITHUB_REPO  (default karmel-spec/blp-knowledge-vault),
 *      VAULT_GITHUB_BRANCH (default main).
 */

export const vaultRepo = process.env.VAULT_GITHUB_REPO || "karmel-spec/blp-knowledge-vault";
export const vaultBranch = process.env.VAULT_GITHUB_BRANCH || "main";
const token = process.env.VAULT_GITHUB_TOKEN || "";

export function vaultConfigured(): boolean {
  return Boolean(token);
}

export interface VaultEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  size: number;
  htmlUrl: string;
}

export interface VaultFile {
  path: string;
  content: string;
  sha: string;
  size: number;
  htmlUrl: string;
}

export interface Author {
  name: string;
  email: string;
}

/** Reject anything that could escape the vault or touch machine-only files. */
export function cleanPath(p: string): string {
  const path = p.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!path || path.split("/").some((s) => s === "." || s === ".." || s === "")) throw new Error("Bad path");
  if (path.startsWith(".obsidian") || path.startsWith(".git")) throw new Error("That path is not editable here");
  return path;
}

const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

async function gh(path: string, init?: RequestInit) {
  if (!token) throw new Error("VAULT_GITHUB_TOKEN is not set — the console can't reach the Knowledge Vault repo");
  const res = await fetch(`https://api.github.com/repos/${vaultRepo}/contents/${encodePath(path)}?ref=${vaultBranch}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

export async function listDir(dir: string): Promise<VaultEntry[] | null> {
  const data = await gh(cleanPath(dir));
  if (!data) return null;
  if (!Array.isArray(data)) throw new Error("Not a folder");
  return (data as Array<{ name: string; path: string; type: string; size: number; html_url: string }>)
    .filter((e) => e.type === "file" || e.type === "dir")
    .map((e) => ({ name: e.name, path: e.path, type: e.type as "file" | "dir", size: e.size, htmlUrl: e.html_url }))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? 1 : -1));
}

export async function getFile(path: string): Promise<VaultFile | null> {
  const data = await gh(cleanPath(path));
  if (!data) return null;
  if (Array.isArray(data)) throw new Error("That path is a folder");
  const f = data as { path: string; sha: string; size: number; html_url: string; content?: string; encoding?: string };
  const content = f.content && f.encoding === "base64" ? Buffer.from(f.content.replace(/\n/g, ""), "base64").toString("utf8") : "";
  return { path: f.path, content, sha: f.sha, size: f.size, htmlUrl: f.html_url };
}

/** Create or update one file as a commit on the vault branch. */
export async function putFile(path: string, content: string, sha: string | null, message: string, author: Author): Promise<{ sha: string; commitUrl: string }> {
  const p = cleanPath(path);
  if (!/\.(md|txt|json|ya?ml|csv)$/i.test(p)) throw new Error("Only text files (.md, .txt, .json, .yaml, .csv) can be edited here");
  const data = (await gh(p, {
    method: "PUT",
    body: JSON.stringify({
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch: vaultBranch,
      ...(sha ? { sha } : {}),
      committer: { name: "BLP Agent Console", email: "agents@brighamlarsonpianos.com" },
      author,
    }),
  })) as { content: { sha: string }; commit: { html_url: string } } | null;
  if (!data) throw new Error("GitHub did not return the saved file");
  return { sha: data.content.sha, commitUrl: data.commit.html_url };
}

export const vaultWebUrl = (path = "") => `https://github.com/${vaultRepo}/${path ? `blob/${vaultBranch}/${encodePath(path)}` : ""}`;
