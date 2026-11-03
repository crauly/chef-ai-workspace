create or replace function public.delete_owned_ingredient_master(p_owner_id uuid,p_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if p_owner_id is null or p_id is null then raise exception 'Invalid ingredient'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text,0));
 if exists(select 1 from public.recipes r, lateral jsonb_array_elements(coalesce(r.state->'materials','[]'::jsonb)) m where r.owner_id=p_owner_id and m->>'ingredient_id'=p_id::text)
 or exists(select 1 from public.recipe_versions v, lateral jsonb_array_elements(coalesce(v.snapshot->'materials','[]'::jsonb)) m where v.owner_id=p_owner_id and m->>'ingredient_id'=p_id::text)
 or exists(select 1 from public.offers where owner_id=p_owner_id and ingredient_id=p_id)
 or exists(select 1 from public.price_notifications where owner_id=p_owner_id and ingredient_id=p_id)
 or exists(select 1 from public.ingredient_images where owner_id=p_owner_id and ingredient_id=p_id)
 then raise exception 'Ingredient has dependent references'; end if;
 delete from public.ingredients where owner_id=p_owner_id and id=p_id;
 return found;
end $$;
revoke all on function public.delete_owned_ingredient_master(uuid,uuid) from public,anon,authenticated;
grant execute on function public.delete_owned_ingredient_master(uuid,uuid) to service_role;

create or replace function public.delete_owned_unit_master(p_owner_id uuid,p_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_symbol text;
begin
 if p_owner_id is null or p_id is null then raise exception 'Invalid unit'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text,0));
 select symbol into v_symbol from public.units where owner_id=p_owner_id and id=p_id for update;
 if not found then return false; end if;
 if exists(select 1 from public.recipes r, lateral jsonb_array_elements(coalesce(r.state->'materials','[]'::jsonb)) m where r.owner_id=p_owner_id and (m->>'unit_id'=p_id::text or (m->>'unit_id' is null and m->>'unit'=v_symbol)))
 or exists(select 1 from public.recipe_versions v, lateral jsonb_array_elements(coalesce(v.snapshot->'materials','[]'::jsonb)) m where v.owner_id=p_owner_id and (m->>'unit_id'=p_id::text or (m->>'unit_id' is null and m->>'unit'=v_symbol)))
 or exists(select 1 from public.ingredients i where i.owner_id=p_owner_id and (i.current_price->>'per_unit_id'=p_id::text or (i.current_price->>'per_unit_id' is null and i.current_price->>'per_unit'=v_symbol)))
 or exists(select 1 from public.offers o where o.owner_id=p_owner_id and o.package_unit=v_symbol)
 then raise exception 'Unit has dependent references'; end if;
 delete from public.units where owner_id=p_owner_id and id=p_id;
 return found;
end $$;
revoke all on function public.delete_owned_unit_master(uuid,uuid) from public,anon,authenticated;
grant execute on function public.delete_owned_unit_master(uuid,uuid) to service_role;