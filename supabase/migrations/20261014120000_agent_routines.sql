-- Team-set routines for the Grok Bot agents (Agent Console, 2026-10-14).
-- One row per routine; the console's scheduled function starts the due ones.
create table if not exists public.agent_routines (
  id bigserial primary key,
  agent text not null,
  title text not null,
  prompt text not null,
  hour int not null default 8 check (hour between 0 and 23),
  minute int not null default 0 check (minute between 0 and 59),
  days int[] not null default '{1,2,3,4,5}',      -- 0 = Sunday … 6 = Saturday, America/Denver
  deliver jsonb not null default '{}'::jsonb,      -- {"telegramChatId": "...", "teamGroup": true}
  enabled boolean not null default true,
  created_by text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_run_key text,                               -- "YYYY-MM-DD HH:MM" of the last slot that ran (dedupe)
  last_run_at timestamptz,
  last_job_id bigint,
  last_status text,
  last_summary text
);
create index if not exists agent_routines_agent on public.agent_routines (agent, enabled);
alter table public.agent_routines enable row level security;
-- written and read only through the console's service key; no anon policy.
