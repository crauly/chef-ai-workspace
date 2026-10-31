-- Realtime voice WS tickets (record of the definition already applied to the
-- dedicated Chef AI Supabase project; created before this file).
-- Replay-safe: IF NOT EXISTS / OR REPLACE only. No data statements.
-- Interface verified read-only 2026-10-31 against the live PostgREST OpenAPI:
-- table public.voice_ws_tickets (token_hash PK text, owner_id uuid,
-- locale text, keywords jsonb, expires_at timestamptz,
-- created_at timestamptz default now()) and
-- POST /rpc/consume_voice_ws_ticket {p_token_hash: text}.
-- Only the server service-role path may read, insert or consume tickets;
-- anon/authenticated hold no table or RPC rights (verified premise).

create table if not exists public.voice_ws_tickets (
  token_hash text primary key,
  owner_id uuid not null,
  locale text not null,
  keywords jsonb not null default '[]'::jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

revoke all on table public.voice_ws_tickets from anon, authenticated;

create or replace function public.consume_voice_ws_ticket(p_token_hash text)
returns table (owner_id uuid, locale text, keywords jsonb)
language sql
security definer
set search_path = public
as $func$
  delete from public.voice_ws_tickets
  where token_hash = p_token_hash
    and expires_at > now()
  returning owner_id, locale, keywords;
$func$;

revoke all on function public.consume_voice_ws_ticket(text) from anon, authenticated;
grant execute on function public.consume_voice_ws_ticket(text) to service_role;
