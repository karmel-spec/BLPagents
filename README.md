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
(accent, avatar, tagline) is preserved. `runtime_system` is free text and is
copied as written, including `Grok Bot`. Run it after editing the sheet,
review the diff, commit.

Melody runs on Grok Bot and is reached at https://t.me/melodylarsonbot
and on her agent page. The console does not dispatch her through the Mac
Hermes gateway and does not treat a missing Hermes heartbeat as her being
down (neutral "Grok Bot" on the fleet board). Until the sheet's runtime
cell for melody says `Grok Bot`, sync keeps that value
(`RUNTIME_MIGRATIONS` in `scripts/sync-registry.mjs`). See **Melody on
Grok Bot** below for the bridge.

## Melody on Grok Bot

Melody's Hermes profile on the Mac is going away. Team members reach her
on Telegram (@melodylarsonbot) and on `/agents/melody` (questions, training,
work requests). Both paths store the message in Supabase and POST it to her
Grok Bot routine webhook. She replies to the console; Telegram chats are
sent back with her bot token.

There is no in-app Claude mind for Melody (`MINDS` in `src/lib/agent-brain.ts`).
`MAILBOXES.melody` in that file is unused until a mind is added. Do not
register her bot on the cloud-brain runner — `/api/telegram/melody` is the
bridge, not `agent_jobs`.

**Migration.** Run `supabase/migrations/20261008143000_melody_bridge.sql`
once in the Supabase SQL editor for `SUPABASE_URL`. It creates
`melody_conversations` and `melody_messages` (service role only).

**Env** (Netlify; never commit values):

| Name | Purpose |
| --- | --- |
| `MELODY_GROKBOT_WEBHOOK_URL` | Grok Bot routine webhook URL |
| `MELODY_GROKBOT_WEBHOOK_KEY` | Sender key from that routine's panel |
| `MELODY_GROKBOT_WEBHOOK_KEY_HEADER` | Header for the key. Default `X-Webhook-Key` (raw key). Set to `Authorization` to send `Bearer <key>` unless the key already starts with `Bearer` or `Basic`. |
| `MELODY_TELEGRAM_ALLOWLIST` | Comma-separated Telegram **user** ids. Empty allows nobody. A private chat's user id is in the canned reply until you add it. |
| `MELODY_CONSOLE_REPLY_KEY` | Bearer token Grok Bot sends to `POST /api/melody/reply` |
| `TELEGRAM_BOT_TOKEN_MELODY` | Bot token for @melodylarsonbot |
| `TELEGRAM_WEBHOOK_SECRET` | Optional. Set a long random string **before** `setWebhook` so the header is a value you know. |
| `PUBLIC_BASE_URL` | `https://blpagents.netlify.app` — this becomes `reply_url` |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | Already used by the cloud agents |

The console page uses the existing team session (or `?key=$BLP_APP_ACCESS_KEY`).
One shared console thread (`console:team`); each Telegram chat is its own
conversation. In groups she answers only when @mentioned, replied to, or
sent a /command, and only if that user's id is on the allowlist.

**Point the bot at the console** after Hermes Melody has stopped polling
(a bot cannot poll and webhook at once):

```bash
curl -X POST "https://blpagents.netlify.app/api/telegram/melody/setup?key=$BLP_APP_ACCESS_KEY"
```

`GET` the same URL for webhook status and the allowlist. `DELETE` removes
the webhook.

**Curl — Telegram inbound** (user id must be on `MELODY_TELEGRAM_ALLOWLIST`):

```bash
curl -X POST "https://blpagents.netlify.app/api/telegram/melody" \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: $TELEGRAM_WEBHOOK_SECRET" \
  -d '{"update_id":1001,"message":{"message_id":1,"date":0,"text":"What is waiting on scheduling?","from":{"id":123456789,"is_bot":false,"first_name":"Karmel"},"chat":{"id":123456789,"type":"private"}}}'
```

**Curl — console inbound** (same thread the agent page shows):

```bash
curl -X POST "https://blpagents.netlify.app/api/melody/thread?key=$BLP_APP_ACCESS_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text":"Draft a reply for a customer asking about a tuning this week."}'
```

The response includes `conversation_id`. **Curl — Melody's reply** (what
the Grok Bot routine should call). Telegram conversations are delivered to
that chat; console replies show on `/agents/melody`:

```bash
curl -X POST "https://blpagents.netlify.app/api/melody/reply" \
  -H "Authorization: Bearer $MELODY_CONSOLE_REPLY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"conversation_id":"<conversation_id>","text":"On it — draft below."}'
```

The webhook payload to Grok Bot is JSON: `source` (`telegram` or `console`),
`conversation_id`, `message_id`, `sender_name`, `sender_role`, `sender_email`,
`telegram_chat_id`, `text`, `timestamp`, `reply_url`, and a short `instruction`
that replies are POSTed to `reply_url`. The sender key is a header, not a
body field.

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
