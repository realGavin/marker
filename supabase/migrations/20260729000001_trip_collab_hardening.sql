-- Hardening pass over 20260728000002_trip_collab.sql after security review.
-- That migration is already applied in production, so nothing in it is edited;
-- everything below is additive and re-runs cleanly on a fresh database.

create extension if not exists pgcrypto;

-- ------------------------------------------------- guessable invite codes
-- WHY: the old default, upper(substr(md5(...), 1, 6)), is 6 hex chars = 24 bits.
-- The code is the ONLY authorization join_trip asks for, so one hit is full
-- read+write on someone's trip, and 16.7M guesses walks the entire space.
-- 6 random bytes = 12 hex chars = 48 bits: ~16 million times harder, still
-- short enough to read aloud or paste into a text message.

-- One place that mints a code. search_path names extensions too because
-- Supabase installs pgcrypto (gen_random_bytes) there, while our functions
-- pin search_path = public.
create or replace function public.new_invite_code()
returns text language sql volatile
set search_path = public, extensions as
$$ select upper(encode(gen_random_bytes(6), 'hex')) $$;

alter table public.trip_plans
  alter column invite_code set default public.new_invite_code();

-- Every code minted under the old default has to be assumed burned, so rotate
-- all of them. Old 6-char codes stop working; only test data exists today.
-- This runs BEFORE the guard trigger is created on purpose: that trigger lets
-- only the owner (auth.uid()) touch invite_code, and a migration has no JWT.
update public.trip_plans set invite_code = public.new_invite_code();

-- ------------------------------------------------- ownership seizure
-- WHY: "trip_plans: update own or member" uses the same expression for USING
-- and WITH CHECK, and WITH CHECK is evaluated against the NEW row. A member
-- passes USING via is_trip_member(), sets user_id = auth.uid(), and the new
-- row then satisfies auth.uid() = user_id — check passes, trip changes hands.
-- The same move rewrites invite_code and locks the real owner's guests out.
-- RLS can never compare OLD to NEW; a row trigger can, so the immutability
-- rules live here instead. Plain function, no SECURITY DEFINER: it should run
-- as the invoking role, and auth.uid() still reads the request JWT claims.
create or replace function public.trip_plans_guard_immutable()
returns trigger language plpgsql as $$
begin
  -- Nobody reassigns a trip, ever. If handing a trip over is ever a feature it
  -- gets its own audited function, not an UPDATE every member can reach.
  if new.user_id is distinct from old.user_id then
    raise exception 'cannot_change_owner';
  end if;

  -- The invite code is the trip's only credential; a member rotating it would
  -- silently revoke everyone else, owner included.
  if new.invite_code is distinct from old.invite_code
     and auth.uid() is distinct from old.user_id then
    raise exception 'not_trip_owner';
  end if;

  -- created_at feeds the plan quota window in the plan-trip function.
  if new.created_at is distinct from old.created_at then
    raise exception 'cannot_change_created_at';
  end if;

  return new;
end $$;

-- UPDATE-only: the plan-trip Edge Function INSERTs trip rows and is unaffected.
create trigger trip_plans_immutable
  before update on public.trip_plans
  for each row execute function public.trip_plans_guard_immutable();

-- ------------------------------------------------- join attempt throttle
-- Defence in depth behind the 48-bit codes: caps how fast one account can
-- probe the code space at all.
create table public.join_attempts (
  user_id uuid not null references public.profiles (id) on delete cascade,
  attempted_at timestamptz not null default now()
);

create index join_attempts_user_idx on public.join_attempts (user_id, attempted_at);

alter table public.join_attempts enable row level security;
-- no policies by design: only join_trip (SECURITY DEFINER) reads or writes it,
-- and clients have no business seeing anyone's attempt history.

-- Same signature and behaviour as before — codes normalized with upper(trim()),
-- 'invalid_code' for anything not found (one message, so there is no oracle
-- beyond "wrong") — plus the throttle. DEFINER because the lookup has to see a
-- trip row before membership exists; the code is the authorization.
create or replace function public.join_trip(code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  t uuid;
  recent int;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;

  -- rolling 1-hour window, pruned on the way in so the table stays small
  delete from join_attempts
    where user_id = auth.uid() and attempted_at < now() - interval '1 hour';
  select count(*) into recent from join_attempts where user_id = auth.uid();
  if recent >= 20 then raise exception 'too_many_attempts'; end if;
  insert into join_attempts (user_id) values (auth.uid());

  select id into t from trip_plans where invite_code = upper(trim(code));
  if t is null then raise exception 'invalid_code'; end if;

  insert into trip_members (trip_id, user_id) values (t, auth.uid())
    on conflict do nothing;
  return t;
end $$;
-- NOTE: a raised exception aborts the whole PostgREST transaction, so the
-- attempt row inserted above survives only on the paths that return normally.
-- Successful joins are therefore counted and wrong guesses are not. Closing
-- that gap means signalling failure without aborting (set response.status and
-- return null) or counting outside the transaction; both change the error the
-- mobile client sees today, so they are deliberately left for a follow-up.
-- The 48-bit codes above, not this counter, are what makes guessing infeasible.

-- Owner-only code rotation: the answer to "someone I invited went rogue".
create or replace function public.rotate_invite_code(trip uuid)
returns text language plpgsql security definer set search_path = public as $$
declare fresh text;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if not exists (
    select 1 from trip_plans where id = trip and user_id = auth.uid()
  ) then
    raise exception 'not_trip_owner';
  end if;

  update trip_plans set invite_code = public.new_invite_code()
    where id = trip
    returning invite_code into fresh;
  return fresh;
end $$;
-- EXECUTE is granted to PUBLIC by default, which is what we want for the
-- authenticated role; both functions do their own auth.uid() checks, and
-- new_invite_code() only ever hands back random hex.

-- ------------------------------------------------------------------ closed
-- BLOCKER 1 — trip ownership seizure. Any trip member could UPDATE user_id to
--   themselves (WITH CHECK looks at the new row, which then passes), taking
--   over the trip and its invite code. Closed by trip_plans_immutable: user_id
--   and created_at are frozen for everyone, invite_code only for the owner.
-- BLOCKER 2 — brute-forceable invite codes. 24-bit codes guarded full
--   read/write access to a trip. Closed by 48-bit codes (new default plus a
--   rotation of every existing row), rotate_invite_code() for revocation, and
--   a per-user join_attempts throttle.
