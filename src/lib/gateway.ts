import { execFileSync } from "child_process";
import { config } from "./config";

/**
 * Client for the BLP Agent Gateway (scripts/agent-gateway.mjs) — the bridge
 * from this (Netlify-hosted) console to the Hermes agents on Karmel's Mac,
 * reached through the Cloudflare tunnel at agents.brighamlarsonpianos.com.
 */

export class GatewayError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

let cachedKey: string | null = null;
function gatewayKey(): string {
  if (config.gatewayKey) return config.gatewayKey;
  if (cachedKey !== null) return cachedKey;
  // Local dev on the agents' Mac: read the shared key from the keychain
  // instead of copying it into a file. Production sets BLP_GATEWAY_KEY.
  try {
    cachedKey = process.platform === "darwin"
      ? execFileSync("security", ["find-generic-password", "-s", "blp-agent-console", "-a", "gateway:key", "-w"], { encoding: "utf8" }).trim()
      : "";
  } catch {
    cachedKey = "";
  }
  return cachedKey;
}

export function gatewayConfigured(): boolean {
  return Boolean(config.gatewayUrl && gatewayKey());
}

export async function gateway<T>(path: string, init?: RequestInit): Promise<T> {
  const key = gatewayKey();
  if (!config.gatewayUrl || !key) throw new GatewayError("Agent gateway not configured (BLP_GATEWAY_URL / BLP_GATEWAY_KEY)", 501);
  let res: Response;
  try {
    res = await fetch(`${config.gatewayUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: { "x-blp-gateway-key": key, "Content-Type": "application/json", ...(init?.headers || {}) },
      cache: "no-store",
      signal: AbortSignal.timeout(25_000),
    });
  } catch (err) {
    throw new GatewayError(`Agent gateway unreachable — is Karmel's Mac awake and the tunnel up? (${err instanceof Error ? err.message : String(err)})`);
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new GatewayError(json.error || `Agent gateway ${res.status}`, res.status);
  return json;
}

export interface GatewayHealth {
  ok: boolean;
  machine: string;
  agents: Record<string, { port: number; up: boolean }>;
}
export interface DispatchReceipt {
  ok: boolean;
  slug: string;
  run_id: string;
  session_id: string;
  status: string;
}
export interface RunStatus {
  slug: string;
  run_id: string;
  status: "started" | "running" | "completed" | "failed" | string;
  output: string | null;
  usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | null;
}
export interface DispatchRecord {
  at: string;
  slug: string;
  requester: string;
  input: string;
  run_id: string;
  status: string;
}
