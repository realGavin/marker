-- H2 follow-up: per-reporter flood cap for report_content().
--
-- 20260808000001_community.sql shipped the report_attempts ledger (table, RLS,
-- (user_id, attempted_at) index) and named the 'too_many_reports' error in
-- comments, but the agent writing report_content() died before wiring the two
-- together: the RPC never touched report_attempts, so one authenticated account
-- could file against thousands of distinct targets and flood the 24h moderation
-- queue. The content_reports unique constraint caps repeats per TARGET; nothing
-- capped reports per REPORTER, which is the axis a flooding account uses.
--
-- Both 20260808000001 (this table) and 20260808000002 (my_blocks) are already
-- applied in production, so neither is edited. This migration only replaces the
-- report_content() function; it re-runs cleanly on a fresh database because the
-- table it depends on exists by the time this file runs.
--
-- The throttle reuses the join_attempts pattern from 20260729000001 verbatim:
-- prune this user's rows older than the rolling 1-hour window on the way in
-- (which keeps the table small — see the cleanup note below), count what
-- remains, cap at 20, then record the attempt. Count runs BEFORE the insert, so
-- the 20th report in an hour succeeds and the 21st raises 'too_many_reports'.
-- now() is the DB clock; no client-supplied timestamp is trusted.

-- ------------------------------------------------------------ report_content
-- Signature, DEFINER header and search_path are IDENTICAL to 20260808000001,
-- and every existing check (not_signed_in, invalid_target, plain_text/left
-- sanitization, target-existence -> not_found, one-per-target on-conflict
-- insert) is carried over unchanged. The ONLY addition is the per-reporter
-- throttle block, placed right after the auth check as join_trip does.
create or replace function public.report_content(target_type text, target_id uuid, reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_type   text := lower(btrim(coalesce(target_type, '')));
  v_target uuid := target_id;
  v_reason text;
  v_exists boolean;
  recent   int;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;

  -- Per-reporter flood cap. Rolling 1-hour window, pruned on the way in so the
  -- ledger stays small; the count then sees only in-window rows. Both the
  -- prune and the count filter on user_id, so they ride report_attempts_user_idx
  -- (user_id, attempted_at). Counting BEFORE the insert makes the 20th report of
  -- the hour succeed and the 21st raise.
  delete from report_attempts
    where user_id = auth.uid() and attempted_at < now() - interval '1 hour';
  select count(*) into recent from report_attempts where user_id = auth.uid();
  if recent >= 20 then raise exception 'too_many_reports'; end if;
  insert into report_attempts (user_id) values (auth.uid());

  if v_type not in ('trip', 'condition_report') then raise exception 'invalid_target'; end if;

  v_reason := left(coalesce(plain_text(reason), ''), 500);

  -- Confirm the target exists so the queue cannot be filled with uuids that
  -- point at nothing. DEFINER is what makes this possible: the reporter cannot
  -- read either table directly.
  if v_type = 'trip' then
    select exists (select 1 from trip_plans where id = v_target) into v_exists;
  else
    select exists (select 1 from condition_reports where id = v_target) into v_exists;
  end if;
  if not v_exists then raise exception 'not_found'; end if;

  insert into content_reports (reporter_id, target_type, target_id, reason)
  values (auth.uid(), v_type, v_target, nullif(v_reason, ''))
  on conflict on constraint content_reports_one_per_target do nothing;
  -- One report per user per target. Repeat submissions are silently absorbed
  -- so the UI can stay dumb and one user cannot inflate a queue.
end $$;
-- NOTE, inherited from join_trip's throttle: a raised exception aborts the whole
-- PostgREST transaction, so the report_attempts row inserted above survives only
-- on paths that return normally. Rejected reports (invalid_target, not_found)
-- are rolled back and therefore do NOT consume the cap; only reports that reach
-- the content_reports insert — i.e. the ones that can actually grow the queue —
-- are counted, which is exactly the axis this cap defends.
--
-- CLEANUP: no periodic delete / cron is needed. The prune above deletes each
-- reporter's out-of-window rows every time they call, so the table's live size
-- is bounded by (active reporters in the last hour x <=20 rows). It cannot grow
-- unbounded. The only rows that could linger are those of a reporter who files
-- once and never returns; at launch scale that residue is negligible and a
-- scheduled sweep would be over-engineering. Revisit only if report volume ever
-- makes the accumulated one-shot rows material.
--
-- DIRECT-INSERT BYPASS: closed already in 20260808000001. content_reports has
-- 'revoke all ... from anon, authenticated' plus an explicit
-- 'revoke insert on public.content_reports from anon, authenticated', so no
-- client role can POST the table directly. This DEFINER RPC is the only write
-- path, which is what makes the cap enforceable rather than cosmetic.
