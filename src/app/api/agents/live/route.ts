import { NextRequest, NextResponse } from "next/server";
import { gateway, gatewayConfigured, type GatewayHealth } from "@/lib/gateway";
import { requireSession, jsonError } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Which agents have a Hermes runtime answering right now (via the gateway). */
export async function GET(req: NextRequest) {
  const guard = requireSession(req);
  if (guard) return guard;
  if (!gatewayConfigured()) return NextResponse.json({ configured: false, agents: {} });
  try {
    const h = await gateway<GatewayHealth>("/health");
    return NextResponse.json({ configured: true, machine: h.machine, agents: h.agents });
  } catch (err) {
    return jsonError(err, (err as { status?: number }).status || 502);
  }
}
