"use client";

import type { AgentConfig } from "@/lib/agents";

/** Shared client-side pieces for the fleet board and agent consoles. */

export type HealthDot = "healthy" | "attention" | "offline" | "none";
export type AgentHealth = {
  slug: string;
  dot: HealthDot;
  machine: string;
  reportedAt: string;
  fresh: boolean;
  online: boolean | null;
  cronsActive: number;
  cronsOk: number;
  issues: string[];
  note?: string;
};
export type HealthMap = Record<string, AgentHealth>;

export const DOT_LABEL: Record<HealthDot, string> = {
  healthy: "Healthy",
  attention: "Needs attention",
  offline: "Offline",
  none: "On deck",
};

/** Sort severity: offline first, then attention, healthy, on deck. */
export const DOT_RANK: Record<HealthDot, number> = { offline: 0, attention: 1, healthy: 2, none: 3 };

export function dotClass(dot: HealthDot): string {
  return dot === "healthy" ? "h" : dot === "attention" ? "w" : dot === "offline" ? "o" : "n";
}

/** "2 min", "3 h", "5 d" — compact age of an ISO timestamp. */
export function ago(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return "now";
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

export function Avatar({ agent, size, live }: { agent: AgentConfig; size: number; live: boolean }) {
  if (agent.avatar) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={agent.avatar}
        alt={agent.name}
        width={size}
        height={size}
        className={live ? "" : "dim"}
        style={{ width: size, height: size, borderRadius: Math.round(size / 4.5), objectFit: "cover", flexShrink: 0 }}
      />
    );
  }
  return (
    <span className="mono-init" aria-hidden style={{ width: size, height: size, background: agent.accent, fontSize: size * 0.5 }}>
      {agent.name[0]}
    </span>
  );
}
