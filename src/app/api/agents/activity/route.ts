import { NextRequest, NextResponse } from "next/server";
import { readAgentActivity } from "@/lib/activity";
import { requireSession, jsonError } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Recent fleet activity (cron runs + heartbeats) for the Activity page. */
export async function GET(req: NextRequest) {
  const guard = requireSession(req);
  if (guard) return guard;
  try {
    return NextResponse.json({ events: await readAgentActivity() });
  } catch (err) {
    return jsonError(err);
  }
}
