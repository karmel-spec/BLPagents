-- Ivory Grok Bot replies in public.agent_messages (the console's shared chat thread).
-- reply_to is the id of the user row that triggered the reply (the webhook's message_id).
--
-- The Agent Console and Ivory Grok Bot both use the service role key. The service
-- role bypasses row level security, so this insert is visible on the console's
-- next read with no new policy. Do not enable RLS in this migration: the Store
-- Map chat shares this table, and enabling RLS here would hide rows from any
-- client that is not the service role.

alter table if exists public.agent_messages
  add column if not exists reply_to bigint;

comment on column public.agent_messages.reply_to is
  'agent_messages.id of the user turn this row answers. Ivory Grok Bot sets it to the webhook message_id.';

create index if not exists agent_messages_reply_to_idx
  on public.agent_messages (reply_to)
  where reply_to is not null;
