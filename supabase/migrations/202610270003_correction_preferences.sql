-- Scoped correction memory. Production owner isolation matches existing schema.
-- Not applied automatically; review before deploying to dedicated project.
create table public.correction_preferences (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  context text not null check(length(context) between 1 and 200),
  heard_phrase text not null check(length(heard_phrase) between 1 and 200),
  preferred_phrase text not null check(length(preferred_phrase) between 1 and 200),
  confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  unique(owner_id, context, heard_phrase, preferred_phrase)
);
create index correction_preferences_lookup_idx on public.correction_preferences
  (owner_id, context, heard_phrase) where confirmed;
alter table public.correction_preferences enable row level security;
-- Service role is used only by trusted FastAPI; browsers have no direct privileges.
revoke all on public.correction_preferences from anon, authenticated;
