import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireSession } from "@/lib/api";
import { parseGoogleSession } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/auth";
import { getFile, listDir, putFile, vaultConfigured, vaultRepo, vaultWebUrl } from "@/lib/vault-github";

export const dynamic = "force-dynamic";

/**
 * GET  /api/vault?path=Agents/melody            → folder listing
 * GET  /api/vault?path=Agents/melody/SOUL.md    → file content + sha
 * PUT  /api/vault  { path, content, sha, message? } → commit to the vault repo
 */
export async function GET(req: NextRequest) {
  const denied = requireSession(req);
  if (denied) return denied;
  try {
    if (!vaultConfigured()) {
      return NextResponse.json({ error: "VAULT_GITHUB_TOKEN is not set on this deployment", configured: false, repo: vaultRepo }, { status: 503 });
    }
    const path = req.nextUrl.searchParams.get("path") || "";
    const kind = req.nextUrl.searchParams.get("kind");
    if (kind === "file") {
      const file = await getFile(path);
      if (!file) return NextResponse.json({ error: "Not found in the vault repo", path }, { status: 404 });
      return NextResponse.json({ file, repo: vaultRepo });
    }
    const entries = await listDir(path);
    if (!entries) return NextResponse.json({ error: "Folder not in the vault repo", path, repo: vaultRepo, url: vaultWebUrl() }, { status: 404 });
    return NextResponse.json({ entries, repo: vaultRepo, url: vaultWebUrl(path) });
  } catch (err) {
    return jsonError(err);
  }
}

export async function PUT(req: NextRequest) {
  const denied = requireSession(req);
  if (denied) return denied;
  try {
    const body = (await req.json()) as { path?: string; content?: string; sha?: string | null; message?: string };
    if (!body.path || typeof body.content !== "string") return jsonError(new Error("path and content are required"), 400);
    const who = parseGoogleSession(req.cookies.get(SESSION_COOKIE)?.value);
    const author = who
      ? { name: who.name || who.email, email: who.email }
      : { name: "BLP team (passcode)", email: "team@brighamlarsonpianos.com" };
    const file = body.path.split("/").pop();
    const message = (body.message?.trim() || `Update ${file} via Agent Console`) + `\n\nEdited by ${author.name} in the BLP Agent Console.`;
    const saved = await putFile(body.path, body.content, body.sha ?? null, message, author);
    return NextResponse.json({ ok: true, ...saved, author: author.name });
  } catch (err) {
    return jsonError(err);
  }
}
