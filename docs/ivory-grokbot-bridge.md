# Ivory Grok Bot bridge

Ivory (slug `ivory`, Tuning Admin) answers only through **Ivory Grok Bot**. The Agent Console, the faces widget, and the dispatch box store the teammate's message in Supabase, then POST it to Ivory Grok Bot's inbound webhook. The webhook wakes the bot. It does **not** return the reply. Ivory Grok Bot writes the reply itself, as a new row in the same thread, using the Supabase REST API and the service key.

Arnold, Clara, Chris, Marcus, Lindsay, Eddy, and every other agent are unchanged.

Do **not** set `TELEGRAM_BOT_TOKEN_IVORY`. Do **not** register `POST /api/telegram/ivory/setup`. That webhook is refused (HTTP 410). Ivory's Hermes profile (port 8644) is not a fallback: the gateway script refuses her, and the console Claude runtime has no Ivory mind.

## What the console does

1. `POST /api/agents/ivory/chat` with `{ "message", "source" }` or `POST /api/agents/ivory/dispatch` with `{ "input" }`.
2. If `IVORY_GROKBOT_WEBHOOK_URL` is unset, the console returns HTTP 200 `{ "status": "moving" }` and stores nothing. The page says Ivory is moving. That is not an error.
3. Otherwise it inserts the user row (below), then POSTs the webhook payload. The page shows **Ivory is working on it…** and polls `GET /api/agents/ivory/chat` every 2.5 seconds for up to 4 minutes.
4. The poll stops when a matching agent row appears. After 4 minutes the page says the reply has not landed yet. A later refresh still shows it, because the thread is just the table.

`source` is one of `console` (agent page), `faces-widget` (the face in the Sales App and the other embeds; the popup URL is `/agents/ivory/chat?from=faces`), or `dispatch` (the task box on her console page).

Sender `name` and `email` come from the Google sign-in session. A passcode-only session is `Team` with an empty email.

## Webhook

`POST` the JSON below to `IVORY_GROKBOT_WEBHOOK_URL`.

Default header, when `IVORY_GROKBOT_WEBHOOK_KEY` is set and the header name is `Authorization`:

```
Authorization: Bearer <IVORY_GROKBOT_WEBHOOK_KEY>
Content-Type: application/json
Accept: application/json
```

The console waits at most 10 seconds for any HTTP success (2xx). The body of that response is ignored. A non-2xx or a network failure is shown as an error. The user row stays in the thread with `meta.status` of `delivery-failed`. The console does not then call Hermes or Claude.

### Payload (version 1)

```json
{
  "v": 1,
  "thread_id": "ivory",
  "message_id": 12345,
  "agent": "ivory",
  "sender": { "name": "Lisa", "email": "lisa@brighamlarsonpianos.com" },
  "source": "faces-widget",
  "text": "What's on the tuning schedule tomorrow?",
  "history": [
    {
      "id": 12340,
      "role": "user",
      "who": "Lisa",
      "text": "Prior turn, whitespace collapsed, cut at 400 characters…",
      "at": "2026-10-08T15:01:00.000Z"
    },
    {
      "id": 12341,
      "role": "agent",
      "who": "Ivory",
      "text": "Prior reply, same trimming.",
      "at": "2026-10-08T15:02:00.000Z"
    }
  ]
}
```

| Field | Type | Meaning |
|---|---|---|
| `v` | number | Always `1`. |
| `thread_id` | string | The registry slug. Always `ivory`. This is the whole thread. There is no separate threads table. |
| `message_id` | number | `agent_messages.id` of the user row just inserted. Put this on the reply. |
| `agent` | string | Same as `thread_id`. Always `ivory`. |
| `sender.name` | string | Display name, or `Team`. |
| `sender.email` | string | Google email, or `""`. |
| `source` | string | `console`, `faces-widget`, or `dispatch`. |
| `text` | string | The new message, unchanged, at most 6,000 characters (dispatch tasks at most 4,000). |
| `history` | array | Up to 8 earlier turns, oldest first, **not** including this message. Each `text` is one line, cut at 400 characters. `role` is `user` or `agent`. |

## Env vars (Netlify, site `blpagents`)

Set these on the Agent Console. Never commit the values.

| Variable | Required | Purpose |
|---|---|---|
| `IVORY_GROKBOT_WEBHOOK_URL` | yes, to deliver | Ivory Grok Bot inbound webhook URL. Unset = friendly "moving" message, no POST, no new row. |
| `IVORY_GROKBOT_WEBHOOK_KEY` | yes, if the webhook checks a key | Secret. Default header is `Authorization: Bearer <this value>`. |
| `IVORY_GROKBOT_WEBHOOK_HEADER` | no | Header **name**. Default `Authorization`. Example: `x-api-key`. |
| `IVORY_GROKBOT_WEBHOOK_VALUE` | no | Full header **value**, if the default construction is wrong. When this is set it is sent as-is, so include `Bearer ` yourself if the header is `Authorization`. When it is unset and the header name is not `Authorization`, the raw key is sent as the value. |

Already required for the thread (the console already uses these; Ivory Grok Bot needs the same project):

| Variable | Who |
|---|---|
| `SUPABASE_URL` | Console, and Ivory Grok Bot (as the REST base). |
| `SUPABASE_SERVICE_KEY` | Console, and Ivory Grok Bot. Service role key, not the anon key. `SUPABASE_SERVICE_ROLE_KEY` is accepted as an alias on the console only. |

Leave unset:

- `TELEGRAM_BOT_TOKEN_IVORY`

Example if the webhook expects a custom header instead of Bearer:

```
IVORY_GROKBOT_WEBHOOK_URL=https://example.invalid/hooks/ivory
IVORY_GROKBOT_WEBHOOK_KEY=replace-me
IVORY_GROKBOT_WEBHOOK_HEADER=x-api-key
IVORY_GROKBOT_WEBHOOK_VALUE=replace-me
```

## How Ivory Grok Bot writes the reply

Table: **`public.agent_messages`** (Supabase project the console calls `SUPABASE_URL`).

One thread: every Ivory row has `agent` = `ivory`. The triggering user row is the one whose `id` equals the webhook's `message_id`.

Insert **one new row**. Do not update the user row. Do not call the console's Claude job runner. There is **no status column to flip**. The new row is the completion. The user row's `meta.status` stays `pending`; leave it. A PATCH of `meta` replaces the whole JSON object and would wipe `provider` and `source`.

### Required columns

| Column | Value |
|---|---|
| `agent` | `ivory` |
| `role` | `agent` (the console also displays `assistant` as Ivory, but write `agent`) |
| `who` | `Ivory` |
| `who_email` | `""` |
| `body` | The reply text. |
| `reply_to` | The webhook `message_id` (integer). Column added by `supabase/migrations/20261008170000_ivory_grokbot_reply_to.sql`. Run that before relying on this column. |
| `run_id` | `grokbot:<message_id>` for example `grokbot:12345` |
| `meta` | JSON object below |

Do not send `id` or `created_at`. The database fills those in.

### `meta` object

```json
{
  "provider": "grokbot",
  "via": "faces-widget",
  "in_reply_to": 12345
}
```

`via` is the webhook's `source`. `in_reply_to` is the webhook's `message_id`.

The console treats a row as the reply when **any** of these match the user message id:

- `reply_to` equals that id
- `meta.in_reply_to` equals that id
- `run_id` equals `grokbot:<id>`
- or it is a later `role: agent` row in the `ivory` thread with none of those links set

Set all three links. The last rule is only a safety net.

### Insert (copy, then replace the placeholders)

```bash
curl -sS -X POST "$SUPABASE_URL/rest/v1/agent_messages" \
  -H "apikey: $SUPABASE_SERVICE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{
    "agent": "ivory",
    "role": "agent",
    "who": "Ivory",
    "who_email": "",
    "body": "Tomorrow has four tunings. I will list them with draft confirmation texts.",
    "reply_to": 12345,
    "run_id": "grokbot:12345",
    "meta": {
      "provider": "grokbot",
      "via": "faces-widget",
      "in_reply_to": 12345
    }
  }'
```

`$SUPABASE_URL` is the project URL with no trailing slash (the same value as the console's `SUPABASE_URL`). `$SUPABASE_SERVICE_KEY` is the service role key. `12345` is `message_id` from the webhook. `via` is `source` from the webhook.

A successful insert returns the new row as a JSON array. The console's next poll (or a refresh) shows `body` as Ivory.

### Read the thread

Newest 20 rows, including the user turn that triggered you:

```bash
curl -sS "$SUPABASE_URL/rest/v1/agent_messages?agent=eq.ivory&order=created_at.desc&limit=20&select=id,agent,role,who,who_email,body,run_id,reply_to,meta,created_at" \
  -H "apikey: $SUPABASE_SERVICE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY"
```

One triggering message:

```bash
curl -sS "$SUPABASE_URL/rest/v1/agent_messages?id=eq.12345&select=id,agent,role,who,who_email,body,run_id,reply_to,meta,created_at" \
  -H "apikey: $SUPABASE_SERVICE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY"
```

Rows come back newest first on the thread read. `role` is `user` or `agent`. Older Hermes/Claude rows for `ivory`, if any, are in this same list; answer the `message_id` you were given, not an older turn.

## Why no new RLS policy

The console reads and writes `agent_messages` with the service role (`src/lib/supa.ts`). Ivory Grok Bot writes with the same key. The service role bypasses RLS, so the insert is visible to the console's next read with no policy change.

The browser never talks to Supabase. It polls `/api/agents/ivory/chat`, which uses the service role.

The migration adds `reply_to` and an index. It does **not** enable RLS. This table is shared with the Store Map chat; turning RLS on here would hide rows from any client that is not the service role.

## Migration

Run `supabase/migrations/20261008170000_ivory_grokbot_reply_to.sql` on the `blp-crm` project (SQL editor or the Supabase CLI) before Ivory Grok Bot sends `reply_to`. Until that column exists, omit `reply_to` from the insert and still set `run_id` and `meta.in_reply_to`. The console matches either.

## Deploy order

The console is safe to deploy before the webhook URL exists: chat stays up, history still loads, and a send shows the moving message. After the migration and the two required env vars are set, the same send wakes Ivory Grok Bot.
