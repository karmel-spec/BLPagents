-- Melody's Grok Bot bridge.
-- Run once in the Supabase SQL editor for the project in SUPABASE_URL
-- (service role only; the console uses SUPABASE_SERVICE_KEY).
-- No anon/authenticated policies: the browser never talks to these tables.

create table if not exists melody_conversations (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('telegram', 'console')),
  -- telegram:<chat id> or console:team (one shared desk on her agent page)
  external_key text not null unique,
  telegram_chat_id text,
  sender_name text not null default '',
  sender_email text not null default '',
  sender_role text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists melody_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references melody_conversations (id) on delete cascade,
  direction text not null check (direction in ('in', 'out')),
  sender_name text not null default '',
  sender_email text not null default '',
  sender_role text not null default '',
  body text not null,
  telegram_update_id text unique,
  telegram_message_id text,
  forward_error text,
  created_at timestamptz not null default now()
);

create index if not exists melody_messages_conversation_idx
  on melody_messages (conversation_id, created_at);

alter table melody_conversations enable row level security;
alter table melody_messages enable row level security;
