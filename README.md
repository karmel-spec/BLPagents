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

Do not register this webhook for Ivory, and do not set `TELEGRAM_BOT_TOKEN_IVORY`. Ivory is Ivory Grok Bot (below), not this Claude runtime.

## Ivory Grok Bot

Ivory (slug `ivory`) is the exception to the Claude console runtime. Chat on her console page, the faces widget (`/agents/ivory/chat?from=faces`), and the dispatch box store the message in `agent_messages` and POST it to her inbound webhook. She writes the reply back into that thread with the Supabase service key. The contract — payload, env vars, and the exact insert — is `docs/ivory-grokbot-bridge.md`.

Set `IVORY_GROKBOT_WEBHOOK_URL` and `IVORY_GROKBOT_WEBHOOK_KEY` on Netlify. Until the URL is set, a send shows that Ivory is moving and does not error. Run `supabase/migrations/20261008170000_ivory_grokbot_reply_to.sql` so her replies can set `reply_to`. She is a cloud agent: the fleet board does not expect a Mac heartbeat, and `scripts/agent-gateway.mjs` will not hand her to Hermes.

**Schedule.** `netlify/functions/arnold-scheduler.mts` fires at :00/:30 UTC and matches America/Denver wall-clock time (`src/lib/arnold-tasks.ts`), so DST never moves a run: `daily-brief` 7:30 Mon–Fri (Top Ten → Sales Console + Telegram), `briefing` 8:00 Mon–Sat (Telegram), `predraft` 10:00/14:00/17:00 Mon–Sat (drafts for approval, up to 8 leads per pass). Each run appends a line under “Cloud runtime (Netlify)” in the vault's `Agents/arnold/STATUS.md`. Run one now:

```bash
curl -X POST "https://blpagents.netlify.app/api/agents/arnold/tasks/briefing?key=$BLP_APP_ACCESS_KEY"
```
then poll `GET /api/agents/arnold/chat/jobs/<jobId>?key=…`; `GET /api/agents/arnold/tasks?key=…` lists the schedule, Denver time, and recent runs.

## Cristofori GrokBot (Chris)

Chris (slug `chris` — routes, the faces widget, and `/agents/chris.jpg` all use it) is **Cristofori GrokBot**, a Grok Bot assistant hosted outside this repo. The console is the bridge.

- **App chat** (Agent Console, and the "Message Chris" button in Store Map and the Sales App) POSTs each message to `CHRIS_GROKBOT_WEBHOOK_URL`. The thread shows "Chris is working on it" and renders the reply when it arrives.
- **Telegram** `@chrislarsonbot` posts to `/.netlify/functions/chris-telegram`. Same bridge. Allowed Telegram user ids are `TELEGRAM_ALLOWED_CHATS_CHRIS` (Brigham and Karmel).
- **Replies** come back to `POST /api/chris/reply` with header `x-chris-bridge-secret`. Telegram replies are `sendMessage` on the Chris bot; app replies are written to the shared Supabase thread.
- Until `CHRIS_GROKBOT_WEBHOOK_URL` and `CHRIS_GROKBOT_WEBHOOK_KEY` are both set, Chris stays on the in-app Claude mind. Nothing switches early.

`POST /api/telegram/chris/setup` will not call `setWebhook`. That call is what disconnects Hermes, and it is a manual step. Env vars, the exact `setWebhook` curl, the Hermes shutdown, and the registry sheet edits are in [CUTOVER.md](CUTOVER.md).

The registry JSON is generated. Change the Chris row in the sheet, then `npm run sync-registry`. The console override in `src/lib/agents.ts` already shows the Cristofori GrokBot name, runtime, and boundaries.

## Eddy Bot (Grok Bot)

Eddy (slug `ed`, portrait `/agents/ed.jpg`) is BLP's video editor. Hermes Eddy is retired and never had Telegram wired. Chat is answered by Eddy Bot on Grok Bot — there is no Claude mind for him.

- **App chat** (Agent Console, `/agents/ed/chat`, and the faces widget) POSTs each message to `EDDY_GROKBOT_WEBHOOK_URL` with the same JSON shape as Chris (`conversation_id`, `channel`, `app`, `sender`, `text`, `history` of the previous 10 turns, `sent_at`). A video card adds `context` (`serial`, `piano`, `card_url`, `user`, and any other short string fields the caller passed).
- **Telegram** `@edlarsonbot` posts to `POST /api/telegram/ed` (the shared webhook route, not a separate Netlify function). Allowed Telegram user ids are `TELEGRAM_ALLOWED_CHATS_ED` only — he does not inherit the sales-group `TELEGRAM_CHAT_ID`. Register with:

```bash
curl -X POST "https://blpagents.netlify.app/api/telegram/ed/setup?key=$BLP_APP_ACCESS_KEY"
```

- **Replies** come back to `POST /api/eddy/reply` with header `x-eddy-bridge-secret`. Telegram replies go out through `@edlarsonbot`. App replies are rows in the shared `agent_messages` thread (`agent=ed`), so the open chat shows them. Each row keeps who said it.
- **Search** on Eddy's chat filters that thread by text, person, or date (newest 500 messages).
- `telegramActive` stays false in the registry until `TELEGRAM_BOT_TOKEN_ED` is set and the sheet's "telegram active" cell is Y. The setup route returns 503 without the token. The token env is `TELEGRAM_BOT_TOKEN_ED` because the slug is `ed`.

### Ask Eddy from the Marketing Engine

`https://blpmarketing.netlify.app` is allowlisted for CORS on `/assistant.js` and `/api/agents/<slug>/chat`, and for `frame-ancestors` on `/agents/<slug>/chat`. The session cookie is `SameSite=Lax`, so the marketing site cannot call the chat API as the signed-in user. Open a top-level window. Sign-in returns to the same chat URL (`?next=`), so the serial and card survive the login redirect.

**Script and button** (preferred). `data-agents=""` loads the helper without floating faces:

```html
<script src="https://blpagents.netlify.app/assistant.js" defer
        data-app="Marketing Engine" data-agents=""></script>
<button type="button" onclick="BLPAssistant.open('ed', {
  app: 'Marketing Engine',
  serial: '48211',
  piano: 'Steinway M',
  card: 'https://blpmarketing.netlify.app/video?q=48211',
  user: 'Alisa'
})">Ask Eddy</button>
```

`BLPAssistant.open` opens `/agents/ed/chat` with those query params and postMessages `{ type: "blp-agent-context", slug, app, serial, piano, card, user, text }` to the popup (`targetOrigin` `https://blpagents.netlify.app`). The chat answers `{ type: "blp-agent-context-ack", slug: "ed" }`.

**Link.** Same fields as query params (`card` is stored as `context.card_url`):

```
https://blpagents.netlify.app/agents/ed/chat?app=Marketing%20Engine&serial=48211&piano=Steinway%20M&card=https%3A%2F%2Fblpmarketing.netlify.app%2Fvideo%3Fq%3D48211&user=Alisa
```

**postMessage** into a window already opened from an allowlisted origin:

```js
chat.postMessage({
  type: "blp-agent-context",
  slug: "ed",
  serial: "48211",
  piano: "Steinway M",
  card: "https://blpmarketing.netlify.app/video?q=48211",
  user: "Alisa"
}, "https://blpagents.netlify.app");
```

The Google session name is the sender on the message. `user` fills the sender only when the console session is the shared passcode (`Team`). The name is also sent inside `context` either way. Env vars are listed in `.env.example`.

## Fleet-wide Grok Bot relay (every other agent)

Brigham, 2026-10-08: all agents move from Hermes to Grok Bots. Ivory, Chris and Eddy keep the per-agent bridges above. Every other agent (Clara, Arnold, Lindsay, Melody, Marcus, Carla) uses one relay: `src/lib/engine.ts` picks the engine (`grokbot` once `GROKBOT_WEBHOOK_URL_<SLUG>` is set, else the in-app `claude` runner), `src/lib/grokbot-relay.ts` wakes the Bot's routine webhook with the job and closes the job when the Bot answers through the MCP server `/api/mcp/<slug>` (tools: `load_mind`, `open_jobs`, `get_job`, `thread_history`, `reply_to_team`, `append_vault_note` plus the agent's own tool set — vault read, Sales Console lookups, Store Map pianos, QuickBooks, approval-gated mail). Plain side door: `GET/POST /api/agents/<slug>/reply`. Sales Console events: `POST /api/agents/<slug>/events` (HMAC, `SALES_EVENTS_SECRET`). Per-agent setup packet with paste-ready Bot instructions: `GET /api/agents/<slug>/grokbot?key=…&format=md`. Other BLP apps call `POST /api/agents/<slug>/chat` with the team key and `{message, who, email, channelNote?, systemNote?}`; `/api/agents/live` reports each agent's engine. Design and recipe: vault `kb/grokbot-relay.md`.
