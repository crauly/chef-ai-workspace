-- Phrase relevance is evaluated before LIMIT, so older confirmed matches survive.
-- SECURITY INVOKER plus service-only EXECUTE keeps demo owner isolation server-side.
create or replace function public.find_relevant_corrections(
  p_owner_id uuid, p_context text, p_instruction text, p_limit integer default 5
) returns table(heard_phrase text, preferred_phrase text)
language sql stable security invoker set search_path = ''
as $$
  select c.heard_phrase, c.preferred_phrase
  from public.correction_preferences c
  where c.owner_id = p_owner_id
    and c.context = p_context
    and c.confirmed
    and position(c.heard_phrase in p_instruction) > 0
  order by c.created_at desc, c.id desc
  limit least(greatest(p_limit, 1), 10);
$$;
revoke all on function public.find_relevant_corrections(uuid,text,text,integer) from public, anon, authenticated;
grant execute on function public.find_relevant_corrections(uuid,text,text,integer) to service_role;
