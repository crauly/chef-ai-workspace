-- M2: atomic recipe + ledger commit. Single SECURITY DEFINER function, so the
-- recipe revision CAS, new-ingredient inserts, optional version snapshot and
-- replay receipt succeed or roll back together. Service-role only; the trusted
-- backend authenticates the caller and validates operations before invoking.
create or replace function public.commit_recipe_with_ledger(
 p_owner_id uuid, p_recipe_id uuid, p_request_id uuid, p_expected_revision bigint,
 p_new_state jsonb, p_title text, p_cost_snapshot jsonb, p_payload_hash text,
 p_save_version boolean default false,
 p_new_ingredients jsonb default '[]'
) returns bigint
language plpgsql security definer set search_path = ''
as $$
declare v_owner uuid := p_owner_id;
        v_revision bigint;
        v_receipt public.mutation_receipts%rowtype;
        v_item jsonb;
        v_ing_id uuid;
        v_ing_name text;
        v_ing_owner uuid;
begin
 if v_owner is null then raise exception 'Owner required'; end if;
 if p_request_id is null or p_new_state is null or p_title is null or btrim(p_title) = ''
   or p_payload_hash is null or p_payload_hash = '' or p_expected_revision is null or p_expected_revision < 0 then
   raise exception 'Invalid mutation payload';
 end if;
 if p_new_ingredients is null or jsonb_typeof(p_new_ingredients) <> 'array' then
   raise exception 'Invalid ledger payload';
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
   -- Negative revision signals a receipt replay so concurrent losers can
   -- distinguish replay from a fresh commit at the same revision number.
   return -v_receipt.resulting_revision;
 end if;
 if v_revision <> p_expected_revision then raise exception 'Stale recipe revision'; end if;
 -- Ledger second gate: the trusted backend already validated, but the database
 -- enforces ownership again so a forged id can never attach another owner's row.
 for v_item in select * from jsonb_array_elements(p_new_ingredients) loop
   if jsonb_typeof(v_item) <> 'object' then raise exception 'Invalid ledger ingredient'; end if;
   begin
     v_ing_id := (v_item->>'id')::uuid;
   exception when others then
     raise exception 'Invalid ledger ingredient';
   end;
   v_ing_name := btrim(coalesce(v_item->>'name', ''));
   if v_ing_name = '' then raise exception 'Invalid ledger ingredient'; end if;
   select owner_id into v_ing_owner from public.ingredients where id = v_ing_id;
   if found then
     if v_ing_owner <> v_owner then raise exception 'Ingredient not owned by caller'; end if;
     raise exception 'Ingredient already registered';
   else
     insert into public.ingredients(id, owner_id, name, brand, spec)
     values(v_ing_id, v_owner, v_ing_name,
            nullif(btrim(coalesce(v_item->>'brand', '')), ''),
            nullif(btrim(coalesce(v_item->>'spec', '')), ''));
   end if;
 end loop;
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
revoke all on function public.commit_recipe_with_ledger(uuid,uuid,uuid,bigint,jsonb,text,jsonb,text,boolean,jsonb) from public, anon, authenticated;
grant execute on function public.commit_recipe_with_ledger(uuid,uuid,uuid,bigint,jsonb,text,jsonb,text,boolean,jsonb) to service_role;
