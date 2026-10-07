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

## Registry sync

`npm run sync-registry` regenerates `src/lib/agent-registry.json` from
Karmel's agent-registry sheet ("Agents" tab — see its README tab for the
schema). Identity fields come from the sheet; console-owned presentation
(accent, avatar, tagline) is preserved. Run it after editing the sheet,
review the diff, commit.

## Carried over from the Sales App (salesapp2)

`agent-registry.json`, `agent-vault.json`, `agents.ts`, `agent-health.ts`,
the 40 portraits in `public/agents/`, both `/api/agents/*` routes, and the
heartbeat reporter script. The Sheets layer (`sheets.ts`) is trimmed to
named-tab reads/writes; auth is the same shared-passcode model with its own
cookie (`blpagents_session`).

## Cloud agent runtime (phase 1, Oct 7 2026)

Arnold runs from this site instead of Hermes on the shop Mac. Everything below needs the runner env (`ANTHROPIC_API_KEY`, `VAULT_GITHUB_TOKEN`, `SUPABASE_*`, `BLP_ARNOLD_ACCESS_KEY`) plus `TELEGRAM_BOT_TOKEN_ARNOLD` and `TELEGRAM_CHAT_ID`.

**Telegram.** `POST /api/telegram/<slug>` is the bot's webhook (secret header verified; chat must be the team group or listed in `TELEGRAM_ALLOWED_CHATS_<SLUG>`; in groups the bot answers only when @mentioned, replied to, or sent a /command). Each message is a job in the shared `agent_messages` thread, so the console and Telegram see one history, and the agent is told who wrote (Telegram name + @username). Register once per bot, after stopping that bot's Hermes adapter (a bot can't poll and webhook at once):

```bash
curl -X POST "https://blpagents.netlify.app/api/telegram/arnold/setup?key=$BLP_APP_ACCESS_KEY"
```
`GET` the same URL for webhook status, `DELETE` to hand the bot back to Hermes.

**Schedule.** `netlify/functions/arnold-scheduler.mts` fires at :00/:30 UTC and matches America/Denver wall-clock time (`src/lib/arnold-tasks.ts`), so DST never moves a run: `daily-brief` 7:30 Mon–Fri (Top Ten → Sales Console + Telegram), `briefing` 8:00 Mon–Sat (Telegram), `predraft` 10:00/14:00/17:00 Mon–Sat (drafts for approval, up to 8 leads per pass). Each run appends a line under “Cloud runtime (Netlify)” in the vault's `Agents/arnold/STATUS.md`. Run one now:

```bash
curl -X POST "https://blpagents.netlify.app/api/agents/arnold/tasks/briefing?key=$BLP_APP_ACCESS_KEY"
```
then poll `GET /api/agents/arnold/chat/jobs/<jobId>?key=…`; `GET /api/agents/arnold/tasks?key=…` lists the schedule, Denver time, and recent runs.
