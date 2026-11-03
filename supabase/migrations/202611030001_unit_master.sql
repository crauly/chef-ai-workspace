-- Chef AI Workspace V1: user-owned unit master, no fixed unit whitelist.
-- Execute only against the dedicated Chef AI Workspace database.
create table public.units (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete cascade,
 symbol text not null check (length(btrim(symbol)) between 1 and 32),
 dimension text not null check (dimension in ('mass','volume','count','other')),
 base_factor numeric check (base_factor > 0),
 aliases text[] not null default '{}',
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique (owner_id, id)
);
create unique index units_owner_symbol_normalized_idx on public.units(owner_id, lower(symbol));
create index units_owner_idx on public.units(owner_id);
alter table public.units enable row level security;
create policy units_owner_read on public.units for select to authenticated
 using (owner_id = (select auth.uid()));
-- Writes use only the trusted server: no authenticated insert/update/delete policy.
revoke insert, update, delete on public.units from anon, authenticated;

-- Resolve both canonical symbol and spoken aliases without choosing between
-- conflicting candidates. The owning user boundary is mandatory.
create or replace function public.resolve_owned_unit_id(
 p_owner_id uuid,p_spoken text
) returns uuid
language plpgsql stable security definer set search_path=''
as $
declare v_ids uuid[];
begin
 select array_agg(u.id) into v_ids
 from public.units u where u.owner_id=p_owner_id
   and (lower(u.symbol)=lower(btrim(p_spoken)) or exists(
     select 1 from unnest(u.aliases) a
     where lower(btrim(a))=lower(btrim(p_spoken))
   ));
 if v_ids is null or cardinality(v_ids)<>1 then
   raise exception 'Unknown or ambiguous unit';
 end if;
 return v_ids[1];
end; $;
revoke all on function public.resolve_owned_unit_id(uuid,text)
 from public,anon,authenticated;
grant execute on function public.resolve_owned_unit_id(uuid,text) to service_role;

-- A unit can be created only by the same transaction that creates an approved
-- recipe. The old standalone create RPC is deliberately absent.
-- In a private V1 test DB, this migration replaces the old recipe-create
-- signature: no alternate initial-save route remains available.
drop function if exists public.create_owned_recipe(uuid,uuid,text,jsonb,jsonb);
create or replace function public.create_owned_recipe(
 p_owner_id uuid, p_recipe_id uuid, p_title text,
 p_initial_state jsonb, p_cost_snapshot jsonb, p_unit_candidates jsonb
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_item jsonb;
declare v_unit_id uuid;
declare v_symbol text;
declare v_dim text;
declare v_material jsonb;
declare v_materials jsonb := '[]'::jsonb;
declare v_state jsonb := p_initial_state;
declare v_unit_ids uuid[] := '{}';
begin
 if p_owner_id is null or p_recipe_id is null
    or p_title is null or btrim(p_title) = ''
    or v_state is null or jsonb_typeof(v_state) <> 'object'
    or v_state->>'id' is distinct from p_recipe_id::text
    or v_state->>'revision' is distinct from '0'
    or p_cost_snapshot is null or jsonb_typeof(p_cost_snapshot) <> 'object'
    or p_unit_candidates is null or jsonb_typeof(p_unit_candidates) <> 'array'
 then raise exception 'Invalid initial recipe'; end if;
 -- Serializes unit token admission and alias edits for this owner.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text,0));
 -- User-confirmed server-side proposal must supply canonical strings and
 -- dimensions. Canonical IDs are resolved under this transaction only.
 for v_item in select * from jsonb_array_elements(p_unit_candidates) loop
   v_symbol := btrim(coalesce(v_item->>'symbol',''));
   v_dim := v_item->>'dimension';
   if length(v_symbol) not between 1 and 32
      or v_dim not in ('mass','volume','count','other')
      or exists(select 1 from public.units u where u.owner_id<>p_owner_id
                   and u.id::text=v_item->>'unit_id')
   then raise exception 'Invalid unit proposal'; end if;
   if exists(
     select 1 from public.units u where u.owner_id=p_owner_id
       and (lower(u.symbol)=lower(v_symbol) or exists(
         select 1 from unnest(u.aliases) a where lower(btrim(a))=lower(v_symbol)
       ))
       and (lower(u.symbol)<>lower(v_symbol) or u.dimension<>v_dim)
   ) then raise exception 'Unit identity collision'; end if;
   insert into public.units(owner_id,symbol,dimension)
   values(p_owner_id,v_symbol,v_dim) on conflict do nothing;
 end loop;
 -- No missing or foreign unit can enter the saved recipe.
 if jsonb_typeof(v_state->'materials') <> 'array'
 then raise exception 'Invalid material lines'; end if;
 for v_material in select * from jsonb_array_elements(v_state->'materials') loop
   if v_material->>'unit' is not null then
     v_unit_id := public.resolve_owned_unit_id(p_owner_id,v_material->>'unit');
     v_material := jsonb_set(v_material,'{unit_id}',to_jsonb(v_unit_id::text),true);
   end if;
   if v_material->'price_override' is not null
      and jsonb_typeof(v_material->'price_override')='object' then
     v_unit_id := public.resolve_owned_unit_id(
         p_owner_id, v_material #>> '{price_override,per_unit}');
     v_material := jsonb_set(v_material,
        '{price_override,per_unit_id}',to_jsonb(v_unit_id::text),true);
   end if;
   v_materials := v_materials || jsonb_build_array(v_material);
 end loop;
 v_state := jsonb_set(v_state,'{materials}',v_materials);
 insert into public.recipes(id,owner_id,title,revision,state)
 values(p_recipe_id,p_owner_id,p_title,0,v_state);
 insert into public.recipe_versions(recipe_id,owner_id,revision,snapshot,cost_snapshot)
 values(p_recipe_id,p_owner_id,0,v_state,p_cost_snapshot);
 return p_recipe_id;
end; $$;
revoke all on function public.create_owned_recipe(uuid,uuid,text,jsonb,jsonb,jsonb)
 from public,anon,authenticated;
grant execute on function public.create_owned_recipe(uuid,uuid,text,jsonb,jsonb,jsonb)
 to service_role;

-- Explicit chef-approved master edit. Preserve canonical ID and the old
-- symbol as an alias so existing recipe snapshots remain readable.
create or replace function public.update_owned_unit(
 p_owner_id uuid, p_unit_id uuid, p_symbol text,
 p_dimension text, p_base_factor numeric, p_aliases text[]
) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare v_symbol text := btrim(p_symbol);
declare v_aliases text[] := coalesce(p_aliases, '{}');
declare v_old_symbol text;
begin
 if p_owner_id is null or p_unit_id is null
    or length(v_symbol) not between 1 and 32
    or p_dimension not in ('mass','volume','count','other')
    or (p_base_factor is not null and p_base_factor <= 0)
    or cardinality(v_aliases)>20
    or exists(select 1 from unnest(v_aliases) a
              where length(btrim(a)) not between 1 and 32)
 then raise exception 'Invalid unit edit'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text,0));
 select symbol into v_old_symbol from public.units
 where owner_id=p_owner_id and id=p_unit_id for update;
 if not found then raise exception 'Unit not found'; end if;
 if lower(v_old_symbol)<>lower(v_symbol) then
   v_aliases := array_append(v_aliases,v_old_symbol);
 end if;
 if cardinality(v_aliases)>20 or exists(
   select 1 from unnest(v_aliases) a
   where lower(btrim(a))=lower(v_symbol)
 ) or exists(
   select 1 from unnest(v_aliases) a group by lower(btrim(a)) having count(*)>1
 ) then raise exception 'Duplicate unit token'; end if;
 if exists(
   select 1 from public.units other
   where other.owner_id=p_owner_id and other.id<>p_unit_id
     and (
       lower(other.symbol)=lower(v_symbol)
       or lower(other.symbol)=any(select lower(btrim(a)) from unnest(v_aliases) a)
       or exists(
         select 1 from unnest(other.aliases) old_alias
         where lower(btrim(old_alias))=lower(v_symbol)
            or lower(btrim(old_alias))=any(select lower(btrim(a)) from unnest(v_aliases) a)
       )
     )
 ) then raise exception 'Unit identity collision'; end if;
 update public.units set symbol=v_symbol,dimension=p_dimension,
                         base_factor=p_base_factor,aliases=v_aliases,updated_at=now()
 where owner_id=p_owner_id and id=p_unit_id;
 return true;
end; $$;
revoke all on function public.update_owned_unit(uuid,uuid,text,text,numeric,text[])
 from public,anon,authenticated;
grant execute on function public.update_owned_unit(uuid,uuid,text,text,numeric,text[])
 to service_role;
