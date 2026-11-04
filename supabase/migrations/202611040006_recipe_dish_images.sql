-- Private recipe illustration persistence. Only the trusted, operator-gated
-- demo backend with verified server-side owner identity may mutate these rows.
-- Never expose service-role credentials or the bucket publicly.
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('chef-recipe-dishes','chef-recipe-dishes',false,4194304,
        array['image/png','image/jpeg','image/webp'])
on conflict (id) do update set
  public=false,file_size_limit=4194304,
  allowed_mime_types=array['image/png','image/jpeg','image/webp'];

create table if not exists public.recipe_dish_images (
  recipe_id uuid primary key references public.recipes(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  storage_path text not null unique,
  mime_type text not null check (mime_type in ('image/png','image/jpeg','image/webp')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dish_path_matches_owner check (
    storage_path like owner_id::text || '/' || recipe_id::text || '/%'
  )
);
create index if not exists recipe_dish_images_owner_idx on public.recipe_dish_images(owner_id);
alter table public.recipe_dish_images enable row level security;
-- No authenticated/anon table policies or storage.objects policies. The server
-- verifies owner via owned recipe query and uses service_role internally.
revoke all on public.recipe_dish_images from anon, authenticated;
