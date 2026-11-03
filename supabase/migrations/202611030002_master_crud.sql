-- Explicit manager-only CRUD, separate from AI proposal handling.
create or replace function public.create_owned_ingredient_master(p_owner_id uuid,p_name text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_name text:=btrim(p_name);
begin
 if p_owner_id is null or length(v_name) not between 1 and 200 then raise exception 'Invalid ingredient'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text,0));
 if exists(select 1 from public.ingredients where owner_id=p_owner_id and lower(btrim(name))=lower(v_name)) then raise exception 'Ingredient exists'; end if;
 insert into public.ingredients(owner_id,name) values(p_owner_id,v_name) returning id into v_id;
 return v_id;
end $$;
create or replace function public.delete_owned_ingredient_master(p_owner_id uuid,p_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if p_owner_id is null or p_id is null then raise exception 'Invalid ingredient'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text,0));
 if exists(select 1 from public.recipes r, lateral jsonb_array_elements(coalesce(r.state->'materials','[]'::jsonb)) m where r.owner_id=p_owner_id and m->>'ingredient_id'=p_id::text) then raise exception 'Ingredient is used by a recipe'; end if;
 if exists(select 1 from public.offers where owner_id=p_owner_id and ingredient_id=p_id) or exists(select 1 from public.price_notifications where owner_id=p_owner_id and ingredient_id=p_id) then raise exception 'Ingredient has procurement history'; end if;
 delete from public.ingredients where owner_id=p_owner_id and id=p_id;
 return found;
end $$;
create or replace function public.create_owned_unit_master(p_owner_id uuid,p_symbol text,p_dimension text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_symbol text:=btrim(p_symbol);
begin
 if p_owner_id is null or length(v_symbol) not between 1 and 32 or p_dimension not in ('mass','volume','count','other') then raise exception 'Invalid unit'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text,0));
 if exists(select 1 from public.units u where u.owner_id=p_owner_id and (lower(u.symbol)=lower(v_symbol) or exists(select 1 from unnest(u.aliases) a where lower(btrim(a))=lower(v_symbol)))) then raise exception 'Unit exists'; end if;
 insert into public.units(owner_id,symbol,dimension) values(p_owner_id,v_symbol,p_dimension) returning id into v_id;
 return v_id;
end $$;
create or replace function public.delete_owned_unit_master(p_owner_id uuid,p_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if p_owner_id is null or p_id is null then raise exception 'Invalid unit'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text,0));
 if exists(select 1 from public.recipes r, lateral jsonb_array_elements(coalesce(r.state->'materials','[]'::jsonb)) m where r.owner_id=p_owner_id and m->>'unit_id'=p_id::text) then raise exception 'Unit is used by a recipe'; end if;
 if exists(select 1 from public.ingredients i where i.owner_id=p_owner_id and i.current_price->>'per_unit_id'=p_id::text) then raise exception 'Unit is used by an ingredient'; end if;
 delete from public.units where owner_id=p_owner_id and id=p_id;
 return found;
end $$;
revoke all on function public.create_owned_ingredient_master(uuid,text),public.delete_owned_ingredient_master(uuid,uuid),public.create_owned_unit_master(uuid,text,text),public.delete_owned_unit_master(uuid,uuid) from public,anon,authenticated;
grant execute on function public.create_owned_ingredient_master(uuid,text),public.delete_owned_ingredient_master(uuid,uuid),public.create_owned_unit_master(uuid,text,text),public.delete_owned_unit_master(uuid,uuid) to service_role;