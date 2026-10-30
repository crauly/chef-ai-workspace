-- P1: procurement owner integrity. RLS alone does not stop a forged
-- service-role write from linking another owner's rows, so the database
-- rejects cross-owner references on insert/update regardless of role.
-- Additive only: one trigger function + four triggers. No backfill, no
-- auto-adoption, no behavior change for same-owner writes.
create or replace function public.check_procurement_owner()
returns trigger
language plpgsql set search_path = ''
as $$
declare v_owner uuid;
begin
  if TG_TABLE_NAME = 'offers' then
    select owner_id into v_owner from public.ingredients where id = NEW.ingredient_id;
    if not found or v_owner <> NEW.owner_id then
      raise exception 'Offer ingredient not owned by caller';
    end if;
    if NEW.supplier_id is not null then
      select owner_id into v_owner from public.suppliers where id = NEW.supplier_id;
      if not found or v_owner <> NEW.owner_id then
        raise exception 'Offer supplier not owned by caller';
      end if;
    end if;
  elsif TG_TABLE_NAME = 'price_observations' then
    select owner_id into v_owner from public.offers where id = NEW.offer_id;
    if not found or v_owner <> NEW.owner_id then
      raise exception 'Observation offer not owned by caller';
    end if;
  elsif TG_TABLE_NAME = 'price_notifications' then
    select owner_id into v_owner from public.price_observations where id = NEW.observation_id;
    if not found or v_owner <> NEW.owner_id then
      raise exception 'Notification observation not owned by caller';
    end if;
    select owner_id into v_owner from public.ingredients where id = NEW.ingredient_id;
    if not found or v_owner <> NEW.owner_id then
      raise exception 'Notification ingredient not owned by caller';
    end if;
  elsif TG_TABLE_NAME = 'ingredients' then
    if NEW.adopted_observation_id is not null then
      select owner_id into v_owner from public.price_observations where id = NEW.adopted_observation_id;
      if not found or v_owner <> NEW.owner_id then
        raise exception 'Adopted observation not owned by caller';
      end if;
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists offers_owner_check on public.offers;
create trigger offers_owner_check
before insert or update on public.offers
for each row execute function public.check_procurement_owner();

drop trigger if exists price_observations_owner_check on public.price_observations;
create trigger price_observations_owner_check
before insert or update on public.price_observations
for each row execute function public.check_procurement_owner();

drop trigger if exists price_notifications_owner_check on public.price_notifications;
create trigger price_notifications_owner_check
before insert or update on public.price_notifications
for each row execute function public.check_procurement_owner();

drop trigger if exists ingredients_adopted_owner_check on public.ingredients;
create trigger ingredients_adopted_owner_check
before insert or update on public.ingredients
for each row execute function public.check_procurement_owner();
