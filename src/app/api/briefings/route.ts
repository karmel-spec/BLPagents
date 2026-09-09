import { NextRequest, NextResponse } from "next/server";
import { readBriefings, BRIEFS_FOLDER_ID } from "@/lib/briefings";
import { requireSession, jsonError } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Today's daily briefings (newest doc per brief) for the Activity page. */
export async function GET(req: NextRequest) {
  const guard = requireSession(req);
  if (guard) return guard;
  try {
    const briefings = await readBriefings();
    return NextResponse.json({
      briefings,
      folderHref: `https://drive.google.com/drive/folders/${BRIEFS_FOLDER_ID}`,
    });
  } catch (err) {
    return jsonError(err);
  }
}
