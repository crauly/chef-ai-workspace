-- Chef AI Workspace: initial Supabase schema. REVIEW BEFORE APPLYING.
-- Confirmed: individual Supabase Auth users own private recipe data.
-- IMPORTANT: commit RPC is callable by service_role ONLY from a trusted backend.
create extension if not exists pgcrypto;

create table public.recipes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  revision bigint not null default 0 check (revision >= 0),
  state jsonb not null,
  updated_at timestamptz not null default now()
);
create index recipes_owner_id_idx on public.recipes(owner_id);

create table public.recipe_versions (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  revision bigint not null check (revision >= 0),
  snapshot jsonb not null,
  cost_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  unique (recipe_id, revision)
);

create table public.mutation_receipts (
  owner_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  resulting_revision bigint not null,
  payload_hash text not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, request_id)
);

create table public.ingredients (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  current_price jsonb,
  created_at timestamptz not null default now()
);

create table public.ingredient_images (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  ingredient_id uuid not null references public.ingredients(id) on delete cascade,
  storage_path text not null unique,
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp')),
  created_at timestamptz not null default now()
);

create index recipe_versions_owner_idx on public.recipe_versions(owner_id, recipe_id);
create index ingredient_images_ingredient_idx on public.ingredient_images(ingredient_id);

alter table public.recipes enable row level security;
alter table public.recipe_versions enable row level security;
alter table public.mutation_receipts enable row level security;
alter table public.ingredients enable row level security;
alter table public.ingredient_images enable row level security;

create policy recipes_select on public.recipes for select to authenticated using (owner_id = (select auth.uid()));
-- Creation policy is temporary until server-side validated creation is implemented.
create policy recipes_insert on public.recipes for insert to authenticated with check (owner_id = (select auth.uid()));
-- No client UPDATE or DELETE grants via RLS.
create policy versions_read on public.recipe_versions for select to authenticated using (owner_id = (select auth.uid()));
create policy versions_insert on public.recipe_versions for insert to authenticated with check (
 owner_id = (select auth.uid()) and exists
 (select 1 from public.recipes r where r.id = recipe_id and r.owner_id = (select auth.uid()))
);
create policy receipts_read on public.mutation_receipts for select to authenticated using (owner_id = (select auth.uid()));
-- Receipts are written by the transactional RPC only; do not allow direct user writes.
create policy ingredients_owner on public.ingredients for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy ingredient_images_read on public.ingredient_images for select to authenticated using (owner_id = (select auth.uid()));
create policy ingredient_images_insert on public.ingredient_images for insert to authenticated with check (
 owner_id = (select auth.uid()) and exists
 (select 1 from public.ingredients i where i.id = ingredient_id and i.owner_id = (select auth.uid()))
);
create policy ingredient_images_delete on public.ingredient_images for delete to authenticated using (owner_id = (select auth.uid()));

-- Perform compare-and-swap and request dedup in one database transaction.
-- A trusted server must authenticate user, validate entire proposed state/cost,
-- then invoke with service_role. Never expose service_role to client.
create or replace function public.commit_recipe_revision(
 p_owner_id uuid, p_recipe_id uuid, p_request_id uuid, p_expected_revision bigint,
 p_new_state jsonb, p_title text, p_cost_snapshot jsonb, p_payload_hash text,
 p_save_version boolean default false
) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare v_owner uuid := p_owner_id;
        v_revision bigint;
        v_receipt public.mutation_receipts%rowtype;
begin
 if v_owner is null then raise exception 'Owner required'; end if;
 if p_request_id is null or p_new_state is null or p_title is null or btrim(p_title) = ''
   or p_payload_hash is null or p_payload_hash = '' or p_expected_revision < 0 then
   raise exception 'Invalid mutation payload';
 end if;
 -- Lock recipe before checking receipts, serializing concurrent requests on this recipe.
 select revision into v_revision from public.recipes
 where id = p_recipe_id and owner_id = v_owner for update;
 if not found then raise exception 'Recipe not found'; end if;
 select * into v_receipt from public.mutation_receipts
 where owner_id = v_owner and request_id = p_request_id;
 if found then
   if v_receipt.recipe_id <> p_recipe_id or v_receipt.payload_hash <> p_payload_hash then
     raise exception 'Request ID reused with a different mutation';
   end if;
   return v_receipt.resulting_revision;
 end if;
 if v_revision <> p_expected_revision then raise exception 'Stale recipe revision'; end if;
 update public.recipes set state = p_new_state, title = p_title,
  revision = v_revision + 1, updated_at = now()
 where id = p_recipe_id and owner_id = v_owner;
 if p_save_version then
   if p_cost_snapshot is null then raise exception 'Missing cost snapshot'; end if;
   insert into public.recipe_versions(recipe_id, owner_id, revision, snapshot, cost_snapshot)
   values(p_recipe_id, v_owner, v_revision + 1, p_new_state, p_cost_snapshot);
 end if;
 insert into public.mutation_receipts(owner_id,request_id,recipe_id,resulting_revision,payload_hash)
 values(v_owner,p_request_id,p_recipe_id,v_revision+1,p_payload_hash);
 return v_revision + 1;
end;
$$;
revoke all on function public.commit_recipe_revision(uuid,uuid,uuid,bigint,jsonb,text,jsonb,text,boolean) from public, anon, authenticated;
grant execute on function public.commit_recipe_revision(uuid,uuid,uuid,bigint,jsonb,text,jsonb,text,boolean) to service_role;
