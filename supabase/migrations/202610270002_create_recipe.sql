-- Trusted-backend-only initial recipe creation.
-- The server MUST authenticate the actor and validate the full recipe and
-- initial calculated snapshot before calling with the service-role key.
create or replace function public.create_owned_recipe(
 p_owner_id uuid, p_recipe_id uuid, p_title text,
 p_initial_state jsonb, p_cost_snapshot jsonb
) returns uuid
language plpgsql security definer set search_path = ''
as $$
begin
 if p_owner_id is null or p_recipe_id is null
    or p_title is null or btrim(p_title) = ''
    or p_initial_state is null or jsonb_typeof(p_initial_state) <> 'object'
    or p_initial_state->>'id' is distinct from p_recipe_id::text
    or p_initial_state->>'revision' is distinct from '0'
    or p_cost_snapshot is null or jsonb_typeof(p_cost_snapshot) <> 'object'
 then
   raise exception 'Invalid initial recipe';
 end if;
 insert into public.recipes(id,owner_id,title,revision,state)
 values(p_recipe_id,p_owner_id,p_title,0,p_initial_state);
 insert into public.recipe_versions(recipe_id,owner_id,revision,snapshot,cost_snapshot)
 values(p_recipe_id,p_owner_id,0,p_initial_state,p_cost_snapshot);
 return p_recipe_id;
end;
$$;
revoke all on function public.create_owned_recipe(uuid,uuid,text,jsonb,jsonb)
 from public, anon, authenticated;
grant execute on function public.create_owned_recipe(uuid,uuid,text,jsonb,jsonb)
 to service_role;
