-- Run on the dedicated Chef DB AFTER migration, app deployment, and secret setup.
-- Vault must already contain chef_research_endpoint and chef_research_bearer.
-- The bearer is the same >=32-character CRON_SECRET configured on the frontend.
begin;
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
do $$
begin
 if not exists(select 1 from vault.decrypted_secrets where name='chef_research_endpoint' and decrypted_secret ~ '^https://[^/]+/api/cron/price-research$')
  or not exists(select 1 from vault.decrypted_secrets where name='chef_research_bearer' and length(decrypted_secret)>=32)
 then raise exception 'Configure dedicated endpoint and bearer in Vault first'; end if;
 perform cron.unschedule(jobid) from cron.job where jobname='chef-price-research';
end $$;
select cron.schedule('chef-price-research','*/5 * * * *',$cron$
 select net.http_get(
  url := (select decrypted_secret from vault.decrypted_secrets where name='chef_research_endpoint'),
  headers := jsonb_build_object('Authorization','Bearer '||(select decrypted_secret from vault.decrypted_secrets where name='chef_research_bearer'))
   || coalesce((select jsonb_build_object('x-vercel-protection-bypass',decrypted_secret) from vault.decrypted_secrets where name='chef_research_vercel_bypass'),'{}'::jsonb),
  timeout_milliseconds := 60000
 );
$cron$);
commit;
