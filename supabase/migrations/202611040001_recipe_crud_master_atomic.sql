-- Atomic, owner-scoped recipe CRUD against the ingredient/unit SSOT.
-- This is a replacement for the legacy commit RPC, not a bypass of the
-- recipe_ingredient_ssot trigger. Apply only to Chef AI Workspace.
create or replace function public.commit_recipe_crud(
 p_owner_id uuid, p_recipe_id uuid, p_request_id uuid,
 p_expected_revision bigint, p_new_state jsonb, p_title text,
 p_cost_snapshot jsonb, p_payload_hash text, p_save_version boolean,
 p_ingredient_entries jsonb
) returns bigint
language plpgsql security definer set search_path=''
as $$
declare v_revision bigint;
declare v_receipt public.mutation_receipts%rowtype;
declare v_item jsonb;
declare v_line jsonb;
declare v_lines jsonb := '[]'::jsonb;
declare v_state jsonb := p_new_state;
declare v_id uuid;
declare v_name text;
declare v_price jsonb;
declare v_unit uuid;
declare v_existing public.ingredients%rowtype;
begin
 if p_owner_id is null or p_recipe_id is null or p_request_id is null
    or p_expected_revision is null or p_expected_revision < 0
    or p_payload_hash is null or p_payload_hash=''
    or p_title is null or btrim(p_title)=''
    or jsonb_typeof(v_state) is distinct from 'object'
    or jsonb_typeof(v_state->'materials') is distinct from 'array'
    or jsonb_typeof(p_ingredient_entries) is distinct from 'array'
 then raise exception 'Invalid recipe CRUD payload'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text,0));
 select revision into v_revision from public.recipes
 where id=p_recipe_id and owner_id=p_owner_id for update;
 if not found then raise exception 'Recipe not found'; end if;
 select * into v_receipt from public.mutation_receipts
 where owner_id=p_owner_id and request_id=p_request_id;
 if found then
   if v_receipt.recipe_id<>p_recipe_id or v_receipt.payload_hash<>p_payload_hash
   then raise exception 'Request ID reused with a different mutation'; end if;
   return v_receipt.resulting_revision;
 end if;
 if v_revision<>p_expected_revision then raise exception 'Stale recipe revision'; end if;
 -- Explicitly approved ingredient master updates and recipe changes are one transaction.
 for v_item in select value from jsonb_array_elements(p_ingredient_entries) loop
   v_id := (v_item->>'id')::uuid;
   v_name := btrim(coalesce(v_item->>'name',''));
   v_price := v_item->'current_price';
   if v_id is null or length(v_name) not between 1 and 200
      or (v_price is not null and jsonb_typeof(v_price) not in ('object','null'))
   then raise exception 'Invalid ingredient entry'; end if;
   if jsonb_typeof(v_price)='object' then
     v_unit := public.resolve_owned_unit_id(p_owner_id,v_price->>'per_unit');
     v_price := jsonb_set(v_price,'{per_unit_id}',to_jsonb(v_unit::text),true);
   end if;
   select * into v_existing from public.ingredients where id=v_id for update;
   if found then
     if v_existing.owner_id<>p_owner_id then raise exception 'Foreign ingredient'; end if;
     -- Ingredient identity is managed in the master, never renamed by recipe edits.
     if jsonb_typeof(v_price)='object' then
       update public.ingredients set current_price=v_price where id=v_id and owner_id=p_owner_id;
     end if;
   else
     if exists(select 1 from public.ingredients
       where owner_id=p_owner_id and lower(btrim(name))=lower(v_name))
     then raise exception 'Ingredient identity collision'; end if;
     insert into public.ingredients(id,owner_id,name,current_price)
     values(v_id,p_owner_id,v_name,
       case when jsonb_typeof(v_price)='object' then v_price else null end);
   end if;
 end loop;
 -- Canonicalize units on every edit; never weaken the SSOT trigger.
 for v_line in select value from jsonb_array_elements(v_state->'materials') loop
   if v_line->>'price_mode' is distinct from 'inherit'
      or jsonb_typeof(v_line->'price_override') is distinct from 'null'
   then raise exception 'Recipe price override forbidden'; end if;
   v_id := (v_line->>'ingredient_id')::uuid;
   if not exists(select 1 from public.ingredients where id=v_id and owner_id=p_owner_id)
   then raise exception 'Recipe ingredient must belong to owner'; end if;
   if v_line->>'unit' is not null then
     v_unit := public.resolve_owned_unit_id(p_owner_id,v_line->>'unit');
     v_line := jsonb_set(v_line,'{unit_id}',to_jsonb(v_unit::text),true);
   else
     v_line := jsonb_set(v_line,'{unit_id}','null'::jsonb,true);
   end if;
   v_lines := v_lines || jsonb_build_array(v_line);
 end loop;
 v_state := jsonb_set(v_state,'{materials}',v_lines);
 update public.recipes set state=v_state,title=p_title,
   revision=v_revision+1,updated_at=now()
 where id=p_recipe_id and owner_id=p_owner_id;
 if p_save_version then
   if p_cost_snapshot is null then raise exception 'Missing cost snapshot'; end if;
   insert into public.recipe_versions(recipe_id,owner_id,revision,snapshot,cost_snapshot)
   values(p_recipe_id,p_owner_id,v_revision+1,v_state,p_cost_snapshot);
 end if;
 insert into public.mutation_receipts(owner_id,request_id,recipe_id,resulting_revision,payload_hash)
 values(p_owner_id,p_request_id,p_recipe_id,v_revision+1,p_payload_hash);
 return v_revision+1;
end;
$$;
revoke all on function public.commit_recipe_crud(uuid,uuid,uuid,bigint,jsonb,text,jsonb,text,boolean,jsonb)
 from public,anon,authenticated;
grant execute on function public.commit_recipe_crud(uuid,uuid,uuid,bigint,jsonb,text,jsonb,text,boolean,jsonb)
 to service_role;
