-- Chef AI Workspace V1: user-owned unit master, no fixed unit whitelist.
-- Execute only against the dedicated Chef AI Workspace database.
create table public.units (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id) on delete cascade,
 symbol text not null check (length(btrim(symbol)) between 1 and 32),
 dimension text not null check (dimension in ('mass','volume','count','other')),
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

-- Atomic, owner-scoped reuse or creation. Only the trusted backend can call.
-- Case-insensitive symbol uniqueness matches the resolver casefold contract.
create or replace function public.ensure_owned_unit(
 p_owner_id uuid, p_symbol text, p_dimension text, p_aliases text[] default '{}'
) returns uuid
language plpgsql security definer set search_path = ''
as $$
declare v_id uuid;
declare v_symbol text := btrim(p_symbol);
begin
 if p_owner_id is null or v_symbol is null or length(v_symbol) not between 1 and 32
    or p_dimension not in ('mass','volume','count','other')
    or array_length(p_aliases,1)>20
    or exists(select 1 from unnest(p_aliases) a where length(btrim(a)) not between 1 and 32)
 then raise exception 'Invalid unit candidate'; end if;
 insert into public.units(owner_id,symbol,dimension,aliases)
 values (p_owner_id,v_symbol,p_dimension,coalesce(p_aliases,'{}'))
 on conflict do nothing
 returning id into v_id;
 if v_id is not null then return v_id; end if;
 select id into v_id from public.units
 where owner_id=p_owner_id and lower(symbol)=lower(v_symbol) and dimension=p_dimension;
 if v_id is null then
   raise exception 'Unit symbol already exists with a different dimension';
 end if;
 return v_id;
end; $$;
revoke all on function public.ensure_owned_unit(uuid,text,text,text[]) from public, anon, authenticated;
grant execute on function public.ensure_owned_unit(uuid,text,text,text[]) to service_role;

-- Explicit management action only: change aliases without changing canonical ID
-- or touching recipe history. No creation through this function.
create or replace function public.update_owned_unit_aliases(
 p_owner_id uuid, p_unit_id uuid, p_aliases text[]
) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare v_aliases text[] := coalesce(p_aliases, '{}');
begin
 if p_owner_id is null or p_unit_id is null
    or cardinality(v_aliases)>20
    or exists(select 1 from unnest(v_aliases) a
              where length(btrim(a)) not between 1 and 32)
 then raise exception 'Invalid unit aliases'; end if;
 -- A changed alias must not make another unit's identity ambiguous.
 if exists(
   select 1 from public.units u
   where u.owner_id=p_owner_id and u.id<>p_unit_id
     and (lower(u.symbol)=any(select lower(btrim(a)) from unnest(v_aliases) a)
       or exists(select 1 from unnest(u.aliases) a, unnest(v_aliases) b
                 where lower(btrim(a))=lower(btrim(b))))
 ) then raise exception 'Unit alias collides with an existing unit'; end if;
 if exists(select 1 from public.units u
           where u.owner_id=p_owner_id and u.id=p_unit_id
             and exists(select 1 from unnest(u.aliases) a
                        where lower(btrim(a))=lower(u.symbol))) then
   -- Existing self aliases are harmless; candidate aliases checked below.
   null;
 end if;
 update public.units set aliases=v_aliases, updated_at=now()
 where owner_id=p_owner_id and id=p_unit_id;
 if not found then raise exception 'Unit not found'; end if;
 return true;
end; $$;
revoke all on function public.update_owned_unit_aliases(uuid,uuid,text[]) from public, anon, authenticated;
grant execute on function public.update_owned_unit_aliases(uuid,uuid,text[]) to service_role;
