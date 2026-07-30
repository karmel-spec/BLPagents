import REGISTRY from "./agent-registry.json";
import VAULT from "./agent-vault.json";

/**
 * BLP Agent Registry — generated from Karmel's agent registry spreadsheet
 * (agent-registry.json), with per-agent overrides below for agents that are
 * wired into the console. `status: "live"` = has a working brain connection.
 */

export interface AgentSchedule {
  time: string;
  days: string;
  what: string;
  where?: string;
}

export interface AgentLink {
  name: string;
  href: string;
  note?: string;
}

/** Per-agent info harvested from the BLP Knowledge Vault (scripts/harvest-vault.mjs). */
export interface VaultInfo {
  mission?: string | null;
  vibe?: string;
  responsibilities?: string[];
  needsApproval?: string[];
  autonomous?: string[];
  currentProjects?: string[];
  openQuestions?: string[];
  requestedCrons?: string[];
  vaultFolder?: string;
  docs?: [string, string][];
}

export interface AgentConfig {
  slug: string;
  name: string;
  role: string;
  department: string;
  tagline: string;
  reportsTo: string;
  accent: string;
  avatar: string | null;
  email?: string | null;
  runtime?: string | null;
  registryStatus?: string;
  crons?: string | null;
  homeComputer?: string | null;
  telegram?: string;
  telegramActive?: boolean;
  healthUrl?: string;
  status: "live" | "coming-soon";
  schedule: AgentSchedule[];
  boundaries: { can: string; never: string; voice?: string };
  links: AgentLink[];
  onMacFiles: [string, string][];
  /** Team-reachable mind links (Drive folders, Obsidian Publish, etc.). */
  mindLinks?: AgentLink[];
  /** Harvested from the Obsidian Knowledge Vault. */
  vault?: VaultInfo;
  widgets?: "arnold";
}

const DEFAULT_BOUNDARIES = {
  can: "To be defined when this agent is wired into the console",
  never: "Send anything to a customer without human approval (house rule for every BLP agent)",
};

/** Rich config for agents that are actually wired up. */
const OVERRIDES: Record<string, Partial<AgentConfig>> = {
  arnold: {
    status: "live",
    widgets: "arnold",
    telegram: "https://t.me/arnoldlarsonbot",
    telegramActive: true,
    healthUrl: "https://arnold.brighamlarsonpianos.com/health",
    tagline:
      "Lead follow-up, pipeline oversight, and daily pre-drafting — always as a ghostwriter in Brigham's voice, never sending without a human's approval.",
    schedule: [
      { time: "8:00 AM", days: "Mon–Sat", what: "Morning sales briefing", where: "BLP Sales Team group" },
      {
        time: "10:00 AM · 2:00 PM · 5:00 PM",
        days: "Mon–Sat",
        what: "Pre-drafting pass (top 8 leads: replies first, then hottest)",
        where: "Drafts → Approvals",
      },
      {
        time: "continuous",
        days: "",
        what: "Quiet-lead sweep adds Arnold as sub-rep (10d never-contacted / 30d worked) — the primary rep keeps the lead; customer text replies ping the group",
      },
    ],
    boundaries: {
      can: "Read the pipeline, draft texts & emails (as Brigham), brief the team, take assigned tasks",
      never:
        "Send anything without human approval · identify himself to customers · edit or delete leads · touch pricing/discounts",
      voice: "Ghostwriter — every customer message speaks and signs as Brigham",
    },
    links: [
      { name: "Chat with Arnold (Telegram)", href: "https://t.me/arnoldlarsonbot", note: "ask him anything, assign work conversationally" },
      { name: "Brain health check", href: "https://arnold.brighamlarsonpianos.com/health", note: "should say status: ok — if not, his Mac is asleep" },
      { name: "His approval queue", href: "https://blpsalesapp.netlify.app/approvals", note: "every draft he writes waits here for a human" },
      { name: "His lead queue", href: "https://blpsalesapp.netlify.app/leads?stale=1", note: "stale leads currently assigned to him" },
    ],
    onMacFiles: [
      ["Identity & soul", "~/Documents/BLP Knowledge Vault/agents/arnold/ (IDENTITY.md, SOUL.md, MEMORY.md)"],
      ["Knowledge base", "~/Documents/BLP Knowledge Vault/agents/arnold/kb/ (Brigham voice corpus, sales strategy rules)"],
      ["Sales Console contract", "~/Documents/BLP Knowledge Vault/agents/arnold/sales-console-api.md"],
      ["Drafting skill", "~/.hermes/profiles/arnold/skills/business-operations/blp-arnold-sales/"],
    ],
  },
};

export const AGENTS: AgentConfig[] = (REGISTRY as Array<Record<string, unknown>>).map((r) => {
  const base: AgentConfig = {
    slug: r.slug as string,
    name: r.name as string,
    role: r.role as string,
    department: r.department as string,
    tagline: r.tagline as string,
    reportsTo: (r.reportsTo as string) || "Karmel",
    accent: r.accent as string,
    avatar: (r.avatar as string) || null,
    email: r.email as string | null,
    runtime: r.runtime as string | null,
    registryStatus: r.registryStatus as string,
    crons: r.crons as string | null,
    homeComputer: r.homeComputer as string | null,
    status: "coming-soon",
    schedule: [],
    boundaries: DEFAULT_BOUNDARIES,
    links: [],
    onMacFiles: [],
    mindLinks: (r.mindLinks as AgentLink[]) || [],
    telegram: (r.telegram as string) || undefined,
    telegramActive: Boolean(r.telegramActive),
  };

  const vault = (VAULT as unknown as Record<string, VaultInfo>)[base.slug];
  if (vault) {
    base.vault = vault;
    if (vault.responsibilities?.length) {
      base.boundaries = {
        can: vault.responsibilities.join(" · "),
        never: vault.needsApproval?.length
          ? `Without human approval: ${vault.needsApproval.map((s) => s.replace(/\.$/, "")).join(" · ")}`
          : DEFAULT_BOUNDARIES.never,
      };
    }
    if (vault.vibe) base.boundaries = { ...base.boundaries, voice: vault.vibe };
    if (vault.docs?.length) base.onMacFiles = vault.docs;
  }

  return { ...base, ...(OVERRIDES[base.slug] || {}) };
});

export function getAgent(slug: string): AgentConfig | undefined {
  return AGENTS.find((a) => a.slug === slug);
}

export const DEPARTMENTS = Array.from(new Set(AGENTS.map((a) => a.department))).sort((a, b) => {
  const order = ["Leadership", "Sales", "Marketing", "Admin & Customer Service", "Accounting & Finance", "Operations", "Shop", "Fieldwork", "Technical"];
  return order.indexOf(a) - order.indexOf(b);
});
