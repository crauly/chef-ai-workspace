-- Ingredient specification in the existing owner-scoped manager RPCs.
-- Migrate only the dedicated Chef AI Workspace database.
-- spec is an identity/display attribute, not a unit conversion factor.
drop function if exists public.create_owned_ingredient_master(uuid,text);
create function public.create_owned_ingredient_master(
 p_owner_id uuid,p_name text,p_spec text
) returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_name text:=btrim(p_name); v_spec text:=nullif(btrim(p_spec),'');
begin
 if p_owner_id is null or length(v_name) not between 1 and 200
    or length(coalesce(v_spec,''))>200 then raise exception 'Invalid ingredient'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text,0));
 -- Same name may designate distinct products, but an identical name+spec
 -- must be resolved by explicit reuse rather than silently duplicated.
 if exists(select 1 from public.ingredients where owner_id=p_owner_id
           and lower(btrim(name))=lower(v_name)
           and lower(coalesce(nullif(btrim(spec),''),''))=lower(coalesce(v_spec,'')))
 then raise exception 'Ingredient exists'; end if;
 insert into public.ingredients(owner_id,name,spec)
 values(p_owner_id,v_name,v_spec) returning id into v_id;
 return v_id;
end $$;
revoke all on function public.create_owned_ingredient_master(uuid,text,text)
 from public,anon,authenticated;
grant execute on function public.create_owned_ingredient_master(uuid,text,text) to service_role;

drop function if exists public.update_owned_ingredient(uuid,uuid,text,jsonb);
create function public.update_owned_ingredient(
 p_owner_id uuid,p_ingredient_id uuid,p_name text,p_price jsonb,p_spec text
) returns boolean language plpgsql security definer set search_path='' as $ingredient_manager$
declare v_name text:=btrim(p_name);
declare v_spec text:=nullif(btrim(p_spec),'');
declare v_unit_id uuid;
declare v_price jsonb:=p_price;
begin
 if p_owner_id is null or p_ingredient_id is null
    or length(v_name) not between 1 and 200
    or length(coalesce(v_spec,''))>200
    or (v_price is not null and jsonb_typeof(v_price) not in ('object','null'))
 then raise exception 'Invalid ingredient update'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text,0));
 if not exists(select 1 from public.ingredients
               where owner_id=p_owner_id and id=p_ingredient_id for update)
 then raise exception 'Ingredient not owned'; end if;
 if exists(select 1 from public.ingredients i where i.owner_id=p_owner_id
           and i.id<>p_ingredient_id and lower(btrim(i.name))=lower(v_name)
           and lower(coalesce(nullif(btrim(i.spec),''),''))=lower(coalesce(v_spec,'')))
 then raise exception 'Ingredient identity collision'; end if;
 if v_price is not null and jsonb_typeof(v_price)='object' then
   raise exception 'Use explicit offer price adoption';
 end if;
 update public.ingredients set name=v_name,spec=v_spec
 where owner_id=p_owner_id and id=p_ingredient_id;
 return true;
end; $ingredient_manager$;
revoke all on function public.update_owned_ingredient(uuid,uuid,text,jsonb,text)
 from public,anon,authenticated;
grant execute on function public.update_owned_ingredient(uuid,uuid,text,jsonb,text)
 to service_role;
