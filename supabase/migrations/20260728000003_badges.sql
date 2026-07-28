-- Collector rank: where does the caller sit among all users, by number of
-- places visited? Powers the profile badge ("Top 5%"). DEFINER because the
-- ranking must count other users' logs, which RLS rightly hides from clients;
-- only aggregates ever leave this function.
create or replace function public.my_rank()
returns table (visited_count integer, top_percent integer)
language sql security definer set search_path = public as $$
  with counts as (
    select user_id, count(*)::int as n
    from place_logs where status = 'visited'
    group by user_id
  ),
  me as (select coalesce((select n from counts where user_id = auth.uid()), 0) as n),
  total as (select count(*)::int as c from counts)
  select
    me.n,
    case
      when me.n = 0 or total.c = 0 then 100
      else greatest(1, ceil(100.0 * ((select count(*) from counts where n > me.n) + 1) / total.c))::int
    end
  from me, total;
$$;
