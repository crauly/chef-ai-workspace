-- Guard every recipe state write, including legacy RPCs and direct service writes.
create or replace function public.enforce_recipe_supplier_owner()
returns trigger language plpgsql security invoker set search_path=''
as $$
declare v_line jsonb; v_supplier uuid;
begin
 if jsonb_typeof(new.state->'materials') is distinct from 'array'
 then raise exception 'Invalid recipe materials'; end if;
 for v_line in select value from jsonb_array_elements(new.state->'materials') loop
   if nullif(v_line->>'supplier_id','') is not null then
     begin
       v_supplier := (v_line->>'supplier_id')::uuid;
     exception when others then
       raise exception 'Invalid recipe supplier ID';
     end;
     if not exists(select 1 from public.suppliers
                   where id=v_supplier and owner_id=new.owner_id)
     then raise exception 'Recipe supplier must belong to owner'; end if;
   end if;
 end loop;
 return new;
end;
$$;
drop trigger if exists enforce_recipe_supplier_owner on public.recipes;
create trigger enforce_recipe_supplier_owner
 before insert or update of state on public.recipes
 for each row execute function public.enforce_recipe_supplier_owner();
