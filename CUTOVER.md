# Cristofori GrokBot — cutover

Chris keeps the slug `chris` (console URL, faces widget, `/agents/chris.jpg`, Telegram route). The display name is Cristofori GrokBot. He answers through a Grok Bot hosted outside this repo. This app forwards every Chris message there and delivers the reply when it comes back.

Nothing points at Grok Bot until the env vars below are set on Netlify. Until then, Chris chat stays on the in-app Claude mind. **Do not call `setWebhook` while deploying.** That call is what stops Hermes from polling `@chrislarsonbot`.

## Env vars to add in Netlify (site `blpagents`)

Set these, then redeploy so functions and the Next server both see them. Values stay in Netlify. Do not commit them.

| Name | Required | Purpose |
|---|---|---|
| `CHRIS_GROKBOT_WEBHOOK_URL` | Yes, to switch Chris | Grok Bot inbound webhook. Each user message is a JSON POST. |
| `CHRIS_GROKBOT_WEBHOOK_KEY` | Yes, to switch Chris | Sender key. Sent as `Authorization: Bearer <key>` unless the header override is set. |
| `CHRIS_GROKBOT_WEBHOOK_KEY_HEADER` | No | Header name for the key. When set, the key is sent as the raw value of this header (no `Bearer` prefix). Letters, digits, and hyphens only. |
| `CHRIS_BRIDGE_SECRET` | Yes, before Grok Bot can reply | Grok Bot must send this as `x-chris-bridge-secret` on `POST /api/chris/reply`. Compared in constant time. Missing header or a mismatch is 401. Unset secret is 503 (the route stays closed). |
| `TELEGRAM_BOT_TOKEN_CHRIS` | Yes, for `@chrislarsonbot` | Bot token from BotFather. |
| `TELEGRAM_ALLOWED_CHATS_CHRIS` | Yes, for Telegram | Comma-separated Telegram user ids. Brigham and Karmel only, same allow-list Hermes used. Chris does **not** inherit `TELEGRAM_CHAT_ID` (that is the sales group). An id not on this list gets a private-chat refusal and no forward. |
| `TELEGRAM_WEBHOOK_SECRET_CHRIS` | Yes, before `setWebhook` | Telegram echoes it as `X-Telegram-Bot-Api-Secret-Token`. Letters, digits, `_` and `-` only. |
| `SUPABASE_URL` | Already used by chat | Thread storage. App replies are rows in `agent_messages`. |
| `SUPABASE_SERVICE_KEY` | Already used by chat | Service role key for that project. |
| `PUBLIC_BASE_URL` | Already set | `https://blpagents.netlify.app` |

`CHRIS_GROKBOT_WEBHOOK_URL` and `CHRIS_GROKBOT_WEBHOOK_KEY` switch the **app** chat (Agent Console, Store Map, Sales App) on the next request. Telegram keeps reaching Hermes until you stop the poller and call `setWebhook`.

## Contract the Grok Bot side must match

**Inbound** — this server POSTs:

```json
{
  "conversation_id": "app:1234",
  "channel": "app",
  "app": "Store Map /",
  "sender": { "name": "Brigham", "id": "brigham@brighamlarsonpianos.com" },
  "text": "What's at the front of the queue?",
  "history": [
    { "role": "user", "name": "Brigham", "text": "…", "at": "2026-10-08T14:00:00.000Z" },
    { "role": "agent", "name": "Cristofori", "text": "…", "at": "2026-10-08T14:01:00.000Z" }
  ],
  "sent_at": "2026-10-08T14:02:00.000Z"
}
```

- `channel` is `app` or `telegram`.
- `app` is the BLP app and page when the faces widget knows it (`Store Map /`, `Sales App /…`), `Agent Console` from the console page, or `Telegram` / `Telegram · <group title>`.
- `conversation_id` is `app:<job id>` or `telegram:<chat id>`. Send that same id back with the reply.
- `history` is the previous 10 messages in that thread (app thread, or that Telegram chat). `text` is the new message and is not repeated in `history`.
- Ack this POST quickly (2xx). The reply is a later call and can take 30 seconds to a few minutes.

**Outbound** — Grok Bot POSTs `https://blpagents.netlify.app/api/chris/reply`:

```
x-chris-bridge-secret: <CHRIS_BRIDGE_SECRET>
```

```json
{ "conversation_id": "app:1234", "channel": "app", "text": "Serial 48211 is next. …" }
```

- `channel: "app"` writes the text into the Chris thread in Supabase. The open chat polls and replaces "Chris is working on it" with the reply.
- `channel: "telegram"` sends the text with the `@chrislarsonbot` token (`sendMessage`). `conversation_id` must be `telegram:<chat id>`.
- The same text for the same `conversation_id` inside two minutes is treated as a retry and is not sent again.

## Manual cutover

Do these in order. Steps 4 and 5 are the ones that disconnect Hermes. This repo cannot do them.

1. **Deploy this branch** with the env vars above set. Confirm `GET https://blpagents.netlify.app/api/chris/reply` returns `{ "ok": true, "hint": "…" }`.
2. **App chat.** In the Store Map or Sales App, use Message Chris (the face; the label was "Message Cris"). Send a shop question with a serial number. The chat should say **Chris is working on it**, the Grok Bot should receive the inbound POST, and its reply to `/api/chris/reply` should show up in the open chat without a reload. The Agent Console page `/agents/chris` is the same thread.
3. **Stop the Hermes poller** on Ivorys-MacBook-Pro-2 (Karmel's Mac), before `setWebhook`. A bot cannot be polled and receive a webhook at the same time.
   - Unload and stop launchd `ai.hermes.gateway-chris` (profile `chris`, API port 8660).
   - Confirm nothing is listening on port 8660.
   - Leave the other Hermes profiles running.
4. **setWebhook** (this is the cutover). From a machine that has the token, not from CI:

```bash
curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN_CHRIS}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "{
    \"url\": \"https://blpagents.netlify.app/.netlify/functions/chris-telegram\",
    \"secret_token\": \"${TELEGRAM_WEBHOOK_SECRET_CHRIS}\",
    \"allowed_updates\": [\"message\"],
    \"drop_pending_updates\": false
  }"
```

Confirm:

```bash
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN_CHRIS}/getWebhookInfo"
```

`url` should be `https://blpagents.netlify.app/.netlify/functions/chris-telegram`. Then send `/start` from an allowed account. The reply is shop-oriented and signs Chris as Cristofori. A normal message should arrive at the Grok Bot webhook with `"channel": "telegram"` and come back through `/api/chris/reply`.

`POST /api/telegram/chris/setup` intentionally refuses to call `setWebhook`. Do not use it for Chris.

5. **Hermes profile cleanup** (after a Telegram round-trip works).
   - Remove the symlink `~/.hermes/profiles/chris/SOUL.md` → the vault.
   - Archive that profile's memory and cron directories.
   - `~/.openclaw/agents/chris` and launchd `com.blp.chris-weekly-wizard` (already stopped) can be archived.
   - The heartbeat script on the Mac skips `chris` so a stopped profile does not show as down. Once the bridge env is set, `netlify/functions/chris-heartbeat.mts` reports him healthy every 10 minutes from the cloud (no crons).
6. **Registry sheet, then sync.** Do not hand-edit `src/lib/agent-registry.json`. It is regenerated by `npm run sync-registry`.

   Sheet: `1mqCmkCD59s6OrgQMjqPZiLc3y1m426WBVUyaQ9F-aTI`, tab **Agents**, header is **row 3**. Edit the row whose `agent_slug` is `chris`:

   | Column (row 3 header) | Set to |
   |---|---|
   | Agent name | `Cristofori (GrokBot)` |
   | runtime_system | `Cristofori GrokBot (cloud)` |
   | home computer | `Cloud (none)` |
   | telegram handle | `chrislarsonbot` (unchanged) |
   | telegram active | `Y` (unchanged) |
   | current active cron jobs | `None — no crons. Shop Manager Briefing at 7:44 AM MT is the Store Map script, not a Hermes job.` |
   | agent_slug | `chris` (do not rename) |

   Leave the avatar column alone if the sheet has one. The portrait stays `/agents/chris.jpg`.

   Tagline is not a sheet column. The console override in `src/lib/agents.ts` owns it (`Cristofori GrokBot — shop manager`). `npm run sync-registry` preserves the tagline already in the JSON.

   Then, with Google credentials available:

   ```bash
   npm run sync-registry
   ```

   Review the diff, commit, and deploy. The `agents.ts` override already shows this name and runtime before the sync, and it still wins after the sync.

7. **Rollback for Telegram only.** `DELETE /api/telegram/chris/setup?key=$BLP_APP_ACCESS_KEY` removes the webhook so a poller can have the bot again. Unset `CHRIS_GROKBOT_WEBHOOK_URL` (or the key) and redeploy to put app chat back on the in-app mind.

## What stays

- Slug `chris` on every route, button, and the portrait.
- Shop Manager Briefing at ~7:44 AM MT (Store Map `DailyReport.gs`). Chris has no cron here.
- He drafts. He does not move stage, spot, or status, and he does not handle pay, hiring, or customer messages.
- `KB/shop-economics-CONFIDENTIAL.md` is not part of the in-app mind and is not in this repo's profile text.
