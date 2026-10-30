-- M1: ingredient procurement ledger (suppliers / offers / price observations).
-- Additive only: no existing table is altered except new NULLABLE columns on
-- public.ingredients. No backfill, no defaults that decide undecided behavior
-- (price-check triggers, thresholds, schedules, auto-adoption are all absent
-- by design; see docs/G0_CONTRACT_REVIEW.md decision requests).
--
-- ROLLBACK (manual, never auto-applied):
--   drop table public.price_notifications;
--   drop table public.price_observations;
--   drop table public.offers;
--   drop table public.suppliers;
--   alter table public.ingredients drop column adopted_observation_id;
--   alter table public.ingredients drop column adopted_at;
--   alter table public.ingredients drop column aliases;
--   alter table public.ingredients drop column spec;
--   alter table public.ingredients drop column brand;

-- 1. Ingredient identity detail. All nullable: unknown brand/spec never blocks
-- a draft. No unique constraint on names: same names from different products
-- stay separate IDs (ADR-009 section 3).
alter table public.ingredients add column brand text;
alter table public.ingredients add column spec text;
alter table public.ingredients add column aliases text[] not null default '{}';
alter table public.ingredients add column adopted_observation_id uuid;
alter table public.ingredients add column adopted_at timestamptz;

-- 2. Suppliers (purchase sources). Owner-scoped. Unknown supplier never blocks.
create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  note text,
  created_at timestamptz not null default now()
);

-- 3. Offers (product / purchase terms per supplier). Same ingredient may have
-- several offers (Amazon / Rakuten / store). No weight inference in schema.
create table public.offers (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  ingredient_id uuid not null references public.ingredients(id) on delete cascade,
  supplier_id uuid references public.suppliers(id) on delete set null,
  product_url text,
  package_quantity text,
  package_unit text,
  shipping_note text,
  created_at timestamptz not null default now()
);
create index offers_ingredient_idx on public.offers(ingredient_id);

-- 4. Price observations (append-only history). Purchase facts and web
-- reference prices are distinguished by source; nothing auto-adopts.
create table public.price_observations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  offer_id uuid not null references public.offers(id) on delete cascade,
  amount_jpy numeric not null check (amount_jpy >= 0),
  currency text not null default 'JPY',
  tax_note text,
  shipping_note text,
  source text not null check (source in ('purchase','web_reference','manual_entry')),
  confirmed boolean not null default false,
  observed_at timestamptz not null default now()
);
create index price_observations_offer_idx on public.price_observations(offer_id);

alter table public.ingredients
  add constraint ingredients_adopted_observation_fk
  foreign key (adopted_observation_id)
  references public.price_observations(id) on delete set null;

-- 5. Price notifications. Reading a notification never adopts a price;
-- adoption stays an explicit app-layer write to adopted_observation_id.
create table public.price_notifications (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  observation_id uuid not null references public.price_observations(id) on delete cascade,
  ingredient_id uuid not null references public.ingredients(id) on delete cascade,
  change_jpy numeric,
  status text not null default 'unread' check (status in ('unread','acknowledged','resolved')),
  created_at timestamptz not null default now(),
  unique(observation_id)
);
create index price_notifications_ingredient_idx on public.price_notifications(ingredient_id);

-- 6. Owner isolation. Same pattern as ingredients_owner: owner-scoped access,
-- no cross-owner visibility. Sensitive recipe writes stay RPC-only; ledger
-- rows carry no calculated totals, so owner-scoped policies match ingredients.
alter table public.suppliers enable row level security;
alter table public.offers enable row level security;
alter table public.price_observations enable row level security;
alter table public.price_notifications enable row level security;

create policy suppliers_owner on public.suppliers for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy offers_owner on public.offers for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy price_observations_owner on public.price_observations for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy price_notifications_owner on public.price_notifications for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
