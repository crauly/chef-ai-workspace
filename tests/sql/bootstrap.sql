-- Disposable PostgreSQL CI only: minimal Supabase auth schema and roles.
-- Do not apply this fixture to a real Supabase project.
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
-- Minimal Storage metadata fixture used by the image migration (no real objects).
create schema storage;
create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
