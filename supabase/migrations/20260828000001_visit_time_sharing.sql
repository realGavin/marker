-- ATOMIC: this migration ALTERS a live table (public.visit_times gains a NOT
-- NULL column with a backfill and a unique index), creates a new table with its
-- own grants, and installs two triggers. It is applied by hand, so it must not
-- depend on the client wrapping it -- a failure partway through would otherwise
-- leave visit_times with a half-populated invite_code, or with the owner-member
-- trigger installed but existing visits un-backfilled, which is silently worse
-- than not shipping at all. Nothing below is transaction-hostile: no CREATE
-- INDEX CONCURRENTLY, no ALTER TYPE ADD VALUE, no VACUUM, no dblink. One
-- transaction is safe.
--
-- RE-RUNNABLE, but note WHY -- three statements are NOT self-guarding:
--   * `create view public.my_visit_times` is bare. It is safe only because the
--     matching `drop view if exists` runs immediately before it. Do not reorder
--     the drop below the create on the assumption that every statement guards
--     itself.
--   * the two `create trigger` statements are bare (Postgres has no
--     `create trigger if not exists`). Both are preceded by
--     `drop trigger if exists ... on ...`, same rule.
--   * `update public.visit_times set invite_code = ...` is bare, but it is
--     filtered `where invite_code is null`, so a second run matches zero rows.
-- Everything else is `add column if not exists` / `create table if not exists` /
-- `create index if not exists` / `create or replace` / `drop policy if exists`.
-- `alter column ... set not null` and `set default` are no-ops when already so.
--
-- STATIC REVIEW ONLY. There is no local Postgres on this machine. Nothing here
-- has been executed, EXPLAINed or tested against a live database; everything
-- below is a static reading of the applied SQL plus the documented behaviour of
-- the constructs used. Gavin applies migrations by hand -- treat the first apply
-- as the first execution.
--
-- DEPENDS ON (all applied, none edited here):
--   20260728000001_tee_times.sql        -- public.visit_times and its owner-only RLS
--   20260729000001_trip_collab_hardening -- public.new_invite_code(), public.join_attempts
--   20260808000001_community.sql        -- schema `private`, the grant/revoke posture
begin;

-- ============================================================================
-- SHAREABLE visit times, with travel time PER PERSON.
--
-- THE FEATURE, in the owner's words: (1) "I live 25 minutes to the course, then
-- notify 25+30 minutes beforehand"; (2) "me and my friend can join this same tee
-- time reminder -- user A sends a tee time invitation".
--
-- WHY TRAVEL TIME IS ON THE MEMBERSHIP AND NOT ON THE VISIT. Two people going to
-- the same 8:10 tee time do not leave at the same time. If travel_minutes sat on
-- visit_times there would be exactly one number for a row two people read, and
-- one of them would be notified at the wrong time -- which is the entire point
-- of the feature failing silently. So the shared object (when and where) lives
-- on visit_times, and the per-person fact (how long it takes ME to get there)
-- lives on the membership row. The OWNER gets a membership row too, so there is
-- no second code path for "the owner's own travel time": everyone is a member,
-- the owner is just the member who also owns the row.
--
-- THE BUFFER IS NOT IN THE DATABASE. "25 + 30" is 25 minutes of travel and a
-- 30-minute get-ready buffer. Only the 25 is a fact about a person; the 30 is a
-- product decision that will get a slider one day. The schema stores
-- travel_minutes and the client computes notify_at = at - (travel_minutes +
-- buffer). A `depart_at` column was considered and rejected: without the buffer
-- it is a half-answer the client would have to redo anyway.
--
-- THREAT MODEL, carried over verbatim from 20260729000001 because this is the
-- same feature shape (a shared row reached by an invite code) and it already
-- shipped a BLOCKER once:
--   * RLS `WITH CHECK` evaluates the NEW row and can never see OLD. Any rule of
--     the form "this column may not change" or "only the owner may change this"
--     is therefore unexpressible in RLS and lives in a BEFORE UPDATE trigger.
--     That is exactly the hole that let a trip_plans member set user_id =
--     auth.uid() and walk off with someone else's trip.
--   * An invite code is a bearer credential. 24-bit codes were a review blocker;
--     public.new_invite_code() (48 bits) is the hardened replacement and is
--     reused verbatim here rather than reinvented.
--   * Every function in schema `public` is a PostgREST endpoint. No helper
--     predicate is created in `public` by this file -- see "no helpers" below.
-- ============================================================================

create extension if not exists pgcrypto;
-- Already installed by 20260729000001; restated so this file also stands up on
-- a fresh database, where new_invite_code() needs gen_random_bytes().

-- ============================================================ invite codes

-- Added nullable first, backfilled, then constrained. The one-shot form
-- (`add column invite_code text not null default public.new_invite_code()`) does
-- happen to evaluate a VOLATILE default once per existing row during the table
-- rewrite, which is how 20260728000002 got away with it -- but that is a subtle
-- property of the rewrite path, and this file is applied by hand against live
-- data. The three-step form makes "every row got its OWN code" a visible
-- statement instead of a trusted implementation detail.
alter table public.visit_times
  add column if not exists invite_code text;

alter table public.visit_times
  alter column invite_code set default public.new_invite_code();

-- Backfill. Filtered on IS NULL so a re-run is a zero-row no-op and, critically,
-- so a retry NEVER rotates a code that has already been handed to a friend.
update public.visit_times
   set invite_code = public.new_invite_code()
 where invite_code is null;

-- Unique as an INDEX, not a table constraint: `create unique index if not
-- exists` is re-runnable, `alter table ... add constraint` is not.
-- If two rows ever collided on 48 random bits (birthday-negligible at this
-- scale) this index build is what would catch it -- and because the whole file
-- is one transaction, the collision rolls everything back and the next run
-- mints fresh codes. A partially-coded table is not a reachable state.
create unique index if not exists visit_times_invite_code_idx
  on public.visit_times (invite_code);

alter table public.visit_times
  alter column invite_code set not null;

-- ============================================================== membership

create table if not exists public.visit_time_members (
  visit_id uuid not null references public.visit_times (id) on delete cascade,
  -- profiles, not auth.users, matching trip_members. profiles.id itself
  -- references auth.users on delete cascade, so account deletion still reaches
  -- these rows; and the auto-profile trigger from 20260724000001 guarantees a
  -- profile row exists for every signup, which is what makes the backfill below
  -- safe.
  user_id uuid not null references public.profiles (id) on delete cascade,
  -- NULL = "not set yet", which is the state every member starts in and the
  -- state the client renders as "add your travel time". 0 is legitimate (you
  -- live at the course). The upper bound is 8 hours: this number is subtracted
  -- from the tee time to schedule a local notification, so an unbounded value is
  -- a way to push someone's reminder to an absurd -- or, with a negative value,
  -- a post-hoc -- moment. The CHECK lives on the COLUMN and not only in
  -- set_travel_minutes(), so it holds on every write path including the service
  -- key.
  travel_minutes int
    constraint visit_time_members_travel_minutes_range
    check (travel_minutes is null or (travel_minutes >= 0 and travel_minutes <= 480)),
  created_at timestamptz not null default now(),
  primary key (visit_id, user_id)
);
-- The PK is (visit_id, user_id): one row per person per visit, so "join twice"
-- is a database-level impossibility rather than an application check, and the
-- leading column serves the per-visit member count.

-- The access-control query is "which visits am I on", i.e. a filter on user_id,
-- which the (visit_id, user_id) primary key cannot serve. Without this index
-- every list-visits call is a sequential scan of the whole membership table.
create index if not exists visit_time_members_user_idx
  on public.visit_time_members (user_id);

alter table public.visit_time_members enable row level security;

-- WHAT ONE MEMBER CAN LEARN ABOUT ANOTHER: the COUNT, and nothing else.
-- This policy is "read your own row" -- not "read rows of visits you are on".
-- A member cannot enumerate the other members' user_ids, cannot see their
-- travel_minutes, and cannot see when they joined. Neither can the OWNER: there
-- is deliberately no owner-reads-all clause here, unlike "trip_members: read",
-- because travel_minutes is a statement about where somebody lives and how they
-- move, which is a materially more sensitive fact than "this person is on this
-- trip". The only cross-member fact the feature actually needs is "how many of
-- us are coming", and that is published as an aggregate by my_visit_times below.
-- Profile identity is not leaked either: profiles is still "read own" from
-- 20260724000001, so even a leaked uuid resolves to nothing.
drop policy if exists "visit_time_members: read own" on public.visit_time_members;
create policy "visit_time_members: read own" on public.visit_time_members
  for select using (auth.uid() = user_id);

-- No INSERT / UPDATE / DELETE policy exists, on purpose. See the grants block --
-- the three RPCs are the only write path, and that is a decision with reasons,
-- not an omission.

-- ======================================================= owner member row

-- WHY DEFINER: the client role has no INSERT privilege on visit_time_members
-- (revoked below), and a trigger function runs as the INVOKING role unless it is
-- SECURITY DEFINER. An invoker trigger here would fail every visit insert with
-- "permission denied for table visit_time_members" -- i.e. it would break the
-- existing add-a-tee-time flow in apps/mobile. DEFINER also puts the insert past
-- the table's RLS, which is correct: this is the system creating the row, not
-- the user.
-- AFTER INSERT, not BEFORE: the FK needs the visit_times row to exist.
-- ON CONFLICT DO NOTHING so a re-created row (or a service-key repair that
-- already added the member) is not an error.
create or replace function public.visit_times_add_owner_member()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into visit_time_members (visit_id, user_id)
  values (new.id, new.user_id)
  on conflict do nothing;
  return null;
end $$;

drop trigger if exists visit_times_owner_member on public.visit_times;
create trigger visit_times_owner_member
  after insert on public.visit_times
  for each row execute function public.visit_times_add_owner_member();

-- Backfill of existing visits. Deliberately UNFILTERED: if some visit's owner
-- somehow has no profiles row, the FK raises and the ENTIRE migration rolls back
-- with a legible error, which is the outcome we want. The alternative -- a
-- `where exists (select 1 from profiles ...)` guard -- would quietly skip that
-- visit, leaving a visit whose own owner is not a member of it, whose
-- set_travel_minutes() would return 'not_found' forever, and which would not
-- appear in the owner's own list. A loud failure beats a silent orphan; the
-- begin/commit wrapper is what makes the loud failure harmless.
insert into public.visit_time_members (visit_id, user_id)
select v.id, v.user_id from public.visit_times v
on conflict do nothing;

-- ==================================================== ownership seizure

-- WHY THIS TRIGGER EXISTS EVEN THOUGH visit_times HAS NO UPDATE POLICY.
-- 20260728000001 created SELECT / INSERT / DELETE policies and no UPDATE policy,
-- so today RLS denies every update outright and this trigger can never fire from
-- PostgREST. It is installed anyway, for the same reason 20260808000001 put
-- sanitization in triggers behind revoked grants: a missing policy is a
-- configuration, a trigger is a property of the table. The moment anybody adds
-- "visit_times: update as member" -- which is the obvious next feature request,
-- "let my friend fix the tee time" -- the ownership-seizure hole from
-- trip_plans reopens verbatim:
--
--     a member passes USING via their membership, sets user_id = auth.uid(),
--     and the NEW row then satisfies auth.uid() = user_id, so WITH CHECK passes
--     and the visit changes hands along with its invite code.
--
-- RLS can never compare OLD to NEW. A row trigger can. So the immutability rules
-- live here, and they hold in advance of the policy that would need them.
--
-- Plain function, NO SECURITY DEFINER, exactly like trip_plans_guard_immutable:
-- it should run as the invoking role, and auth.uid() still reads the request JWT
-- claims either way.
create or replace function public.visit_times_guard_immutable()
returns trigger language plpgsql as $$
begin
  -- Nobody reassigns a visit, ever. Not the owner, not a member, not by any
  -- policy that might be added later. If handing a visit over is ever a feature
  -- it gets its own audited function, not an UPDATE somebody can reach.
  if new.user_id is distinct from old.user_id then
    raise exception 'cannot_change_owner';
  end if;

  -- The primary key is the handle every member row points at.
  if new.id is distinct from old.id then
    raise exception 'cannot_change_id';
  end if;

  if new.created_at is distinct from old.created_at then
    raise exception 'cannot_change_created_at';
  end if;

  -- Everything else on this row is owner-only. The invite_code is the visit's
  -- only credential -- a member rotating it silently revokes everyone else, the
  -- owner included -- and `at` / `place_id` are the shared facts every member's
  -- reminder is computed from, so a member who could move them could move
  -- someone else's alarm. auth.uid() is compared against OLD.user_id, which is
  -- the whole reason this is a trigger and not a WITH CHECK.
  if auth.uid() is distinct from old.user_id
     and (new.invite_code is distinct from old.invite_code
          or new.at        is distinct from old.at
          or new.place_id  is distinct from old.place_id) then
    raise exception 'not_owner';
  end if;

  return new;
end $$;

-- UPDATE-only. The insert path (apps/mobile inserts visit_times directly, under
-- the existing "own visit_times insert" policy) is untouched.
drop trigger if exists visit_times_immutable on public.visit_times;
create trigger visit_times_immutable
  before update on public.visit_times
  for each row execute function public.visit_times_guard_immutable();

-- ==================================================================== RPCs
--
-- NO HELPER PREDICATES. 20260728000002 created public.is_trip_member() and
-- public.is_trip_owner() because its RLS policies needed to escape policy
-- recursion between two tables. Nothing here needs that: the only policy on
-- visit_time_members is "auth.uid() = user_id", which touches no second table,
-- and the list surface is a definer view that bypasses RLS entirely. So no
-- is_visit_member() is created -- in public OR in private. 20260808000001's
-- lesson was that every function in `public` is a POST /rpc/ endpoint; the
-- cheapest version of that risk is the helper that does not exist. The three
-- functions below are DEFINER and do their membership tests inline.

-- ------------------------------------------------------------- join_visit
-- Returns the visit id. DEFINER so the code lookup can see a visit row before
-- any membership exists -- the code IS the authorization, exactly as in
-- join_trip.
--
-- THE THROTTLE REUSES public.join_attempts, the same ledger join_trip writes,
-- ON PURPOSE. The budget being defended is "how fast can one account probe a
-- 48-bit invite-code space", and trip codes and visit codes come out of the same
-- generator into the same shape. A separate visit_join_attempts table would hand
-- an attacker 40 guesses an hour instead of 20 by alternating between the two
-- RPCs. One ledger, one cap, both doors.
--
-- ERROR CODE DIVERGENCE, deliberate: join_trip raises 'invalid_code' for an
-- unknown code; this raises 'not_found', which is the vocabulary the mobile
-- contract for this feature specifies. Behaviour is identical -- ONE message for
-- every miss, so there is no oracle beyond "wrong".
create or replace function public.join_visit(code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id   uuid;
  recent int;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;

  -- Rolling 1-hour window, pruned on the way in so the ledger stays small; both
  -- statements filter on user_id so they ride join_attempts_user_idx. Counting
  -- BEFORE the insert makes the 20th join of the hour succeed and the 21st raise.
  delete from join_attempts
    where user_id = auth.uid() and attempted_at < now() - interval '1 hour';
  select count(*) into recent from join_attempts where user_id = auth.uid();
  if recent >= 20 then raise exception 'too_many_attempts'; end if;
  insert into join_attempts (user_id) values (auth.uid());

  select id into v_id from visit_times where invite_code = upper(trim(code));
  if v_id is null then raise exception 'not_found'; end if;

  -- Refuse a visit that has already happened. Without this the join SILENTLY
  -- succeeds and then vanishes: the member row is created, but the client skips
  -- scheduling (fire time in the past) and the row never enters the upcoming
  -- list, so the user sees a join that appears to have failed. Worse, a joined
  -- past visit fed the "how did it go?" prompt, which writes a real rating into
  -- the public average -- letting someone rate a place they never went to.
  -- Same 'not_found' as a bad code, deliberately: a distinct code here would
  -- confirm that a stranger's code is real, just expired.
  if exists (select 1 from visit_times where id = v_id and at < now()) then
    raise exception 'not_found';
  end if;

  -- Explicit, rather than join_trip's `on conflict do nothing`: the mobile
  -- contract wants to tell the user "you are already on this one" instead of
  -- silently re-succeeding. This is also the branch the OWNER hits if they scan
  -- their own code, which falls out for free precisely because the owner holds
  -- an ordinary member row.
  if exists (
    select 1 from visit_time_members where visit_id = v_id and user_id = auth.uid()
  ) then
    raise exception 'already_member';
  end if;

  insert into visit_time_members (visit_id, user_id) values (v_id, auth.uid());
  return v_id;
end $$;
-- NOTE, inherited from join_trip's throttle and unchanged: a raised exception
-- aborts the whole PostgREST transaction, so the join_attempts row above
-- survives only on paths that RETURN normally. Successful joins are counted;
-- wrong guesses and 'already_member' are rolled back and cost nothing. Closing
-- that gap means signalling failure without aborting, which changes the error
-- the client sees, so it is left alone here for the same reason it was there.
-- The 48-bit codes, not this counter, are what makes guessing infeasible.

-- ----------------------------------------------------- set_travel_minutes
-- Writes the CALLER's row and only the caller's row. The WHERE clause pins
-- user_id = auth.uid() with no parameter influencing it, so there is no argument
-- a legitimate member of a shared visit can pass to reach somebody else's row --
-- the target user is not an input to this function at all. That is the point:
-- being a member of a shared object is not permission to write another member's
-- half of it.
--
-- minutes IS NULL is allowed and means "unset it again"; the range check mirrors
-- the column CHECK so the caller gets 'invalid_minutes' instead of a raw
-- constraint-violation string.
create or replace function public.set_travel_minutes(visit uuid, minutes int)
returns void language plpgsql security definer set search_path = public as $$
declare hit int;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;

  if minutes is not null and (minutes < 0 or minutes > 480) then
    raise exception 'invalid_minutes';
  end if;

  update visit_time_members
     set travel_minutes = minutes
   where visit_id = visit and user_id = auth.uid();

  get diagnostics hit = row_count;
  -- Zero rows means the visit does not exist, was deleted, or the caller is not
  -- on it. One error for all three: this function is DEFINER and can see every
  -- visit, so distinguishing them would turn it into a probe for "does this uuid
  -- name a real tee time".
  if hit = 0 then raise exception 'not_found'; end if;
end $$;

-- ------------------------------------------------------------ leave_visit
-- Members only. The owner CANNOT leave their own visit: their member row is what
-- carries their travel time and what makes them visible in my_visit_times, so
-- dropping it would leave them owning a row they can no longer see or configure
-- while everyone else's reminders keep firing. The owner's exit is DELETE the
-- visit, which cascades every member row -- and which is also the only
-- revocation this feature has (see ACCEPTED below).
--
-- ERROR CODE NOTE: 'owner_cannot_leave' is the one code here NOT in the agreed
-- vocabulary. None of the agreed codes fits -- 'not_owner' says the opposite of
-- what happened, and 'not_found' would be a lie the client would render as "this
-- tee time is gone". Flagged explicitly so the mobile side adds the one string.
create or replace function public.leave_visit(visit uuid)
returns void language plpgsql security definer set search_path = public as $$
declare hit int;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;

  if exists (select 1 from visit_times where id = visit and user_id = auth.uid()) then
    raise exception 'owner_cannot_leave';
  end if;

  delete from visit_time_members
   where visit_id = visit and user_id = auth.uid();

  get diagnostics hit = row_count;
  if hit = 0 then raise exception 'not_found'; end if;
end $$;

-- EXECUTE on functions is granted to PUBLIC by default, which is what we want
-- for the authenticated role: all three do their own auth.uid() check on the
-- first line, and none of them takes a target user as an argument.

-- =================================================================== view
--
-- WHY A VIEW AND NOT AN RPC: the app lists visits with ONE query and wants to
-- sort/filter it client-side; a view is a table-shaped GET that PostgREST can
-- order and paginate, an RPC is a POST that cannot. It is also the shape the
-- existing useVisitTimes() hook already speaks.
--
-- security_invoker = false is LOAD-BEARING, not boilerplate, for two independent
-- reasons:
--   1. member_count. Under invoker semantics the count would run against
--      "visit_time_members: read own" and every visit would report exactly 1.
--      The aggregate is only truthful because the view reads the table with the
--      owner's privileges.
--   2. shared visits at all. There is deliberately NO member SELECT policy on
--      visit_times (see below), so an invoker view would show a member nothing.
--
-- WHY THERE IS NO "visit_times: read as member" POLICY. Adding one was the
-- obvious move and it is wrong: invite_code is a column ON that row, so a member
-- with raw SELECT on visit_times reads the visit's bearer credential and becomes
-- a second distributor of the owner's invitation. Routing members through this
-- view instead lets the code be masked per-caller. Members reach shared visits
-- ONLY here; the owner keeps their direct table access from 20260728000001.
--
-- auth.uid() still resolves inside a definer view -- it reads the request JWT
-- GUC, which DEFINER does not change -- so the filter is per-caller even though
-- the view runs with the owner's privileges.
drop view if exists public.my_visit_times;
create view public.my_visit_times
with (security_invoker = false) as
  select
    v.id,
    v.place_id,
    p.name as place_name,
    p.slug as place_slug,
    v.at,
    v.created_at,
    (v.user_id = auth.uid()) as is_owner,
    -- Owner-only. A member gets NULL here and therefore cannot re-share the
    -- owner's invitation.
    case when v.user_id = auth.uid() then v.invite_code end as invite_code,
    -- The caller's OWN travel time. NULL = not set yet. No other member's
    -- travel_minutes appears anywhere in this view.
    me.travel_minutes,
    (select count(*)::int from public.visit_time_members m2 where m2.visit_id = v.id)
      as member_count
  from public.visit_times v
  join public.places p on p.id = v.place_id
  join public.visit_time_members me
    on me.visit_id = v.id and me.user_id = auth.uid();
-- THE INNER JOIN ON me IS THE ACCESS CONTROL. You see a visit if and only if you
-- hold a member row on it -- one rule, no "owner OR member" disjunction to get
-- subtly wrong, which works precisely because the owner is a member. With no JWT
-- auth.uid() is null, the join matches nothing, and the view is empty (it is
-- revoked from anon below anyway).
--
-- member_count is a CORRELATED SCALAR SUBQUERY, and this is a deliberate
-- departure from published_trips in 20260808000001, which was rewritten the
-- other way. The reasoning there was that the community feed must evaluate votes
-- for EVERY published trip before it can order by them, so a grouped join that
-- aggregates the whole table once beats N subquery executions. This query is the
-- opposite access pattern: it is driven by one user's handful of memberships, so
-- a grouped subquery would aggregate the entire membership table to answer a
-- five-row question, while the correlated form does five index lookups on the
-- (visit_id, user_id) primary key's leading column. Same trade, opposite side.
--
-- member_count INCLUDES THE OWNER, so it is >= 1 on every row and reads as
-- "people on this tee time". The client renders it directly; there is no
-- "+ 1 for the owner" convention to remember.
--
-- No ORDER BY: PostgREST callers order it themselves (the existing hook asks for
-- at ascending).

-- ================================================================== grants
-- Supabase's default privileges hand SELECT -- and on tables, more -- to anon
-- and authenticated on every new object, so each one below is revoked
-- explicitly first. Without that, RLS is the only thing between a client and the
-- raw rows and one policy mistake exposes the whole table.
revoke all on public.visit_time_members from anon, authenticated;
grant select on public.visit_time_members to authenticated;

-- THE DECISION, stated: the three RPCs are the ONLY write path to this table,
-- and each leg has its own reason.
--
-- INSERT is revoked because a direct insert is a total bypass of the invite
--   code. `POST /visit_time_members {visit_id, user_id: me}` would add the
--   caller to any visit whose uuid they can guess or scrape, with no code, no
--   throttle, and no owner involvement. An RLS WITH CHECK cannot save this: the
--   only thing it could assert is "the row is yours", which is exactly what the
--   attacker's row already says.
--
-- UPDATE is revoked because of the OLD/NEW blindness again, and this one is
--   subtle enough to spell out. A policy of "auth.uid() = user_id" for UPDATE
--   looks watertight, and the column CHECK already bounds travel_minutes -- but
--   visit_id is part of the primary key and is just another updatable column. A
--   member of visit X could UPDATE their own row's visit_id to visit Y and land
--   inside a visit they were never invited to. WITH CHECK sees only the new row,
--   which still says "this row is mine", so it passes. set_travel_minutes()
--   never takes visit_id as a target of assignment at all.
--
-- DELETE is revoked so leave_visit() is the only exit, which is what makes
--   "the owner cannot leave" enforceable. A direct DELETE of the owner's own
--   member row would strand a visit its own owner cannot see or configure, and
--   would quietly decrement member_count for everyone else. Note this does NOT
--   affect the ON DELETE CASCADE from visit_times: FK cascades run as a system
--   action and ignore table privileges, so deleting a visit still cleans up its
--   members.
--
-- SELECT is granted, scoped by "visit_time_members: read own" to the caller's
--   own rows. The view already carries the caller's travel_minutes, so this is
--   a convenience for reading one visit's row directly; it exposes nothing the
--   view does not.
--
-- Explicit re-revoke, so the intent survives someone adding a role-level grant
-- in six months without reading this block.
revoke insert, update, delete on public.visit_time_members from anon, authenticated;

-- visit_times keeps its existing SELECT / INSERT / DELETE grants -- apps/mobile
-- inserts and deletes the table directly and must keep working. UPDATE is
-- revoked: there is no UPDATE policy, so RLS already denies it, but Supabase's
-- default grant means the privilege is sitting there waiting for the first
-- policy somebody adds. Belt and braces in front of visit_times_immutable.
revoke update on public.visit_times from anon, authenticated;

-- join_attempts has RLS enabled with no policies, so it is already unreadable;
-- the revoke makes that a privilege fact rather than a policy fact. join_trip()
-- and join_visit() are both SECURITY DEFINER and use the function owner's
-- privileges, so neither is affected.
revoke all on public.join_attempts from anon, authenticated;

-- my_visit_times is authenticated-only ON PURPOSE, mirroring published_trips:
-- every row of it is selected by an auth.uid() comparison, and a definer view
-- read with no JWT is a filter comparing against NULL. It returns nothing today
-- either way; the revoke means it cannot start returning something after an
-- innocent-looking edit to the join.
revoke all on public.my_visit_times from anon;
grant select on public.my_visit_times to authenticated;

-- ============================================================================
-- ADVERSARIAL PASS -- static review, no database was executed against.
--
-- 1. OWNERSHIP SEIZURE (the blocker that bit trip_plans). CLOSED, three deep.
--    visit_times has no UPDATE policy, so RLS denies every update; UPDATE is
--    revoked from anon and authenticated, so the privilege is not even there;
--    and visit_times_immutable freezes user_id, id and created_at for EVERYONE
--    and gates invite_code / at / place_id on auth.uid() = OLD.user_id. The
--    trigger is the layer that survives the future "let my friend edit the tee
--    time" policy, and it is the only one of the three that can compare OLD to
--    NEW. The sideways version -- seizing by moving your MEMBER row -- is closed
--    by the UPDATE revoke on visit_time_members (see the grants block).
--
-- 2. INVITE-CODE BRUTE FORCE. CLOSED to the same standard as trips. Codes come
--    from public.new_invite_code(): 6 random bytes = 48 bits, ~2.8e14 values,
--    the hardened generator that replaced the 24-bit blocker. join_visit() is
--    the only door, it is throttled at 20 attempts per rolling hour on the
--    SHARED join_attempts ledger (so alternating with join_trip does not double
--    the budget), and every miss returns the identical 'not_found'. At 20/hour a
--    single account needs ~1.6 billion years of continuous guessing for one
--    expected hit; the practical bound is account creation cost, not the code.
--    The residual noted in 20260729000001 stands unchanged: a raised exception
--    rolls back the attempt row, so only SUCCESSFUL joins are actually counted.
--    ACCEPTED, same as there -- the entropy is the defence, the counter is the
--    speed bump.
--
-- 3. A MEMBER EDITS THE VISIT (moves the tee time, changes the course, rotates
--    the code). CLOSED by the same three layers as (1). Note what is at stake
--    and why it is not merely vandalism: `at` is the value every member's local
--    notification is computed from, so a member who could move it moves other
--    people's alarms.
--
-- 4. A MEMBER SETS SOMEBODY ELSE'S TRAVEL TIME. CLOSED. set_travel_minutes()
--    does not accept a user argument -- there is no input that steers the WHERE
--    clause off auth.uid() -- and the direct-UPDATE path is revoked. Being a
--    legitimate member of a shared object grants nothing over another member's
--    row.
--
-- 5. ABSURD REMINDER TIMES via travel_minutes. CLOSED at the column, not just in
--    the RPC: the CHECK constraint rejects negatives and anything over 480
--    minutes on every write path, service key included. Worst case a member
--    moves their OWN reminder up to 8 hours early. Nobody can move anyone
--    else's.
--
-- 6. A DEPARTED MEMBER RETAINS ACCESS. CLOSED. leave_visit() deletes the row,
--    and the view's inner join on that row is the entire read grant -- no row,
--    no visibility, immediately and with nothing cached server-side. Same for a
--    deleted visit (cascade) and a deleted account (cascade through profiles).
--    ACCEPTED: the departed member still knows the code they were given and can
--    re-join, because there is no rotation (see 9). A tee time is a single dated
--    event; the owner's revocation is deleting it.
--
-- 7. LEAKING ONE MEMBER'S IDENTITY OR TRAVEL HABITS TO ANOTHER. CLOSED, stated
--    precisely: the ONLY fact one member learns about the others is
--    member_count, an integer >= 1. Not their user_id, not their handle, not
--    their travel_minutes, not when they joined -- and not even to the OWNER,
--    which is a deliberate departure from "trip_members: read", because
--    travel_minutes is a proxy for where a person lives. profiles is still "read
--    own", so no uuid resolves to a person anyway. RESIDUAL, ACCEPTED: at
--    member_count = 2 the count is a perfect oracle for "my one friend joined /
--    left", and polling it reveals arrival and departure timing. That is not a
--    leak so much as the feature -- "is my friend coming" is the question the
--    number exists to answer -- and it discloses no attribute of that person
--    beyond a fact they created by acting on the owner's own invitation.
--
-- 8. UNBOUNDED GROWTH. BOUNDED on every table this file touches.
--    visit_time_members is capped by (visits x members) and cascades away with
--    its visit; there is no orphan path, and the PK makes join-spam a no-op
--    beyond the first row. join_attempts self-prunes on the way in and is
--    capped at ~20 rows per user active in the last hour, unchanged from
--    20260729000001. ACCEPTED, unchanged from 20260728000001: nothing ever
--    deletes a PAST visit_times row -- the table grows with tee times booked,
--    forever, and my_visit_times has no date floor so a heavy user's list grows
--    without bound. That predates this file and is a cleanup job (or a `where at
--    > now() - interval '1 day'` in the client), not a security matter.
--    ACCEPTED: an attacker with a valid code can join a visit and leave it in a
--    loop; the throttle caps the join half at 20/hour and the PK means the row
--    count never exceeds one per person.
--
-- 9. ACCEPTED, NOT CLOSED -- the rest.
--    * NO rotate_visit_code(). trips got one because a trip plan is a long-lived
--      document worth keeping after evicting somebody. A visit is one dated
--      event: deleting and re-creating it is a two-tap revocation that also
--      clears the member list, which is usually what "someone I invited went
--      rogue" actually wants. If visits ever grow attachments or history this
--      needs revisiting, and it is a five-line DEFINER function when it does.
--    * NO owner-kick. The owner cannot remove a specific member; they delete the
--      visit. Same reasoning, and it keeps "your membership is yours to end"
--      true, which is why leave_visit() needs no owner branch.
--    * THE OWNER CANNOT SEE WHO JOINED, only how many. This is a real product
--      cost of the privacy posture in (7) and it will be asked for. When it is,
--      the right shape is a definer RPC returning handles ONLY -- never
--      travel_minutes -- not a widened SELECT policy.
--    * A SERVICE-KEY UPDATE to at / place_id is blocked by
--      visit_times_immutable, because auth.uid() is NULL for the service role
--      and NULL is distinct from any owner. Same property trip_plans_immutable
--      already has for invite_code, and the same workaround: repairs go through
--      a DEFINER function or drop the trigger for the duration. Noted so nobody
--      rediscovers it during an incident.
--    * THE 30-MINUTE BUFFER IS CLIENT-SIDE. The database guarantees
--      travel_minutes is a sane per-person integer; it does not and cannot
--      guarantee the notification actually fires at at - (travel + buffer).
--      Reminders are local notifications on the device, unchanged from
--      20260728000001.
--    * NO 'not_owner' PATH IS REACHABLE TODAY. It is raised only by
--      visit_times_immutable, which cannot fire while visit_times has no UPDATE
--      policy. It is in the mobile vocabulary for the day that policy is added,
--      and stating that now is cheaper than a surprise later.
-- ============================================================================

commit;
