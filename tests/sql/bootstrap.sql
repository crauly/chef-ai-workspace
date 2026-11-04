-- Disposable PostgreSQL CI only: minimal Supabase auth schema and roles.
-- Do not apply this fixture to a real Supabase project.
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create table auth.users(id uuid primary key);
create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
