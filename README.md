# BLP Agents — Mission Control

The agent console for Brigham Larson Pianos: the full digital-team roster
(41 agents, 9 departments), live fleet health, and a console page per agent.

Design: **Mission Control** — black department rail, ivory paper, thin red
bar, dense fleet table with an activity feed. Chosen from four concepts
pitched July 30, 2026.

## How it works

- **Roster** comes from `src/lib/agent-registry.json` (Karmel's agent
  registry sheet) enriched by `src/lib/agent-vault.json` (harvested from the
  BLP Knowledge Vault) — both static, imported at build time.
- **Health** comes from the `Agent Status` tab of the Leads Log spreadsheet.
  Every machine that hosts agents runs `scripts/agent-heartbeat.mjs` on a
  10-minute cron and POSTs to `/api/agents/heartbeat` (here or on the Sales
  Console — both apps share the same tab, so no reporter changes are needed).
- `/api/agents/health` computes the health dot per agent: fresh heartbeat +
  clean crons = healthy; failed/missed crons = needs attention; no heartbeat
  in 45 min = offline; never reported = on deck.

## Run it

```bash
npm install
npm run dev   # port 8873
```

Copy `.env.example` to `.env.local` and fill in the Google service-account
credentials to see live health (without them the fleet renders from the
registry alone). Set `BLP_APP_ACCESS_KEY` to gate the app behind the team
passcode.

## Carried over from the Sales App (salesapp2)

`agent-registry.json`, `agent-vault.json`, `agents.ts`, `agent-health.ts`,
the 40 portraits in `public/agents/`, both `/api/agents/*` routes, and the
heartbeat reporter script. The Sheets layer (`sheets.ts`) is trimmed to
named-tab reads/writes; auth is the same shared-passcode model with its own
cookie (`blpagents_session`).
