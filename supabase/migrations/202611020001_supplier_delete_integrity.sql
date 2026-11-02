-- Preserve offer -> supplier linkage under concurrent supplier deletion.
-- Existing FK used ON DELETE SET NULL; switch to RESTRICT so the database
-- atomically rejects deletion if an offer references this supplier.
-- No rows are modified. Deployment must apply this migration before enabling delete UI.
alter table public.offers
  drop constraint if exists offers_supplier_id_fkey;
alter table public.offers
  add constraint offers_supplier_id_fkey
  foreign key (supplier_id) references public.suppliers(id) on delete restrict;
