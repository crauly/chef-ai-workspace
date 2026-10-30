-- M6 history fix (PENDING: not applied to any database by this change).
-- Notifications recomputed their comparison from the *current* adopted
-- price, so a later adoption change rewrote past history on screen.
-- Persist the creation-time basis instead; observations are append-only,
-- so basis + candidate rows reproduce the original comparison exactly.
alter table public.price_notifications
  add column basis_observation_id uuid
    references public.price_observations(id) on delete set null;
alter table public.price_notifications
  add column unit_basis text;
-- change_jpy keeps its meaning: the JPY unit-price difference per
-- unit_basis at creation time. Backfill is intentionally absent: rows
-- created before this column exist keep nulls and the API falls back
-- to a live comparison for them.
