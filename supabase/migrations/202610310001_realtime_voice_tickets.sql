-- Realtime voice WS tickets (record of the definition already applied to the
-- dedicated Chef AI Supabase project; created before this file).
-- Replay-safe: IF NOT EXISTS / OR REPLACE / idempotent constraint blocks only.
-- No data statements. No DDL re-execution or deploy is needed for this fix.
--
-- Live definition verified read-only 2026-10-31 against the applied DB:
-- table public.voice_ws_tickets (token_hash PK text, owner_id uuid,
-- locale text, keywords jsonb, expires_at timestamptz,
-- created_at timestamptz default now()) and
-- function public.consume_voice_ws_ticket(p_token_hash text).
-- Only the server service-role path may read, insert or consume tickets;
-- anon/authenticated hold no table or RPC rights (verified premise).
--
-- Notes on privileges: CREATE OR REPLACE FUNCTION does not reset existing
-- grants, so the explicit REVOKE statements below are the enforcement point
-- for service-role-only execution. They are recorded here to match the
-- applied DB; re-running them is a no-op permission-wise.

create table if not exists public.voice_ws_tickets (
  token_hash text primary key,
  owner_id uuid not null,
  locale text not null,
  keywords jsonb not null default '[]'::jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint voice_ws_tickets_token_hash_check
    check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint voice_ws_tickets_locale_check
    check (locale in ('en', 'ja')),
  constraint voice_ws_tickets_keywords_check
    check (jsonb_typeof(keywords) = 'array')
);

-- Idempotent backfill for databases created by the earlier revision of this
-- file that lacked the named CHECK constraints. Skipped when already present.
do $$
begin
  begin
    alter table public.voice_ws_tickets
      add constraint voice_ws_tickets_token_hash_check
      check (token_hash ~ '^[0-9a-f]{64}$');
  exception when duplicate_object then null;
  end;
  begin
    alter table public.voice_ws_tickets
      add constraint voice_ws_tickets_locale_check
      check (locale in ('en', 'ja'));
  exception when duplicate_object then null;
  end;
  begin
    alter table public.voice_ws_tickets
      add constraint voice_ws_tickets_keywords_check
      check (jsonb_typeof(keywords) = 'array');
  exception when duplicate_object then null;
  end;
end
$$;

revoke all on table public.voice_ws_tickets from public, anon, authenticated;

create or replace function public.consume_voice_ws_ticket(p_token_hash text)
returns table (owner_id uuid, locale text, keywords jsonb)
language sql
security invoker
set search_path to ''
as $func$
  delete from public.voice_ws_tickets as t
  where t.token_hash = p_token_hash
    and t.expires_at > now()
  returning t.owner_id, t.locale, t.keywords;
$func$;

revoke all on function public.consume_voice_ws_ticket(text)
  from public, anon, authenticated;
grant execute on function public.consume_voice_ws_ticket(text) to service_role;
