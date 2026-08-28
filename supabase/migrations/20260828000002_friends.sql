-- ============================================================================
-- FRIENDS. The first hole ever cut in the place_logs wall.
--
-- READ THIS FIRST. Until this file, public.place_logs has been strictly
-- owner-only: "place_logs: crud own" (20260724000001) is the ONLY policy on the
-- table, and nothing -- no view, no RPC, no aggregate -- has ever handed one
-- user another user's log rows. place_rating_stats (20260808000001) reads the
-- table but emits only a k-anonymised average over >= 3 raters with no user_id
-- attached, and my_rank() emits only the caller's own percentile.
--
-- This migration deliberately opens a door in that wall. The door is exactly
-- this wide, decided by the owner, and NOT ONE COLUMN WIDER:
--
--   ALLOWED to an ACCEPTED friend: handle, display_name, home_region, the
--     COUNT of places they have visited, their percentile badge, and the LIST
--     of places they have visited -- place identity only (id/slug/name/city/
--     region), for drawing pins on a map.
--   FORBIDDEN, on every path, forever: note (never), rating (never),
--     want-to-play / wishlist status, visited_on dates, and the existence of
--     any log row whose status is not 'visited'.
--
-- HOW THE DOOR IS KEPT THAT WIDE -- the single most important design decision
-- in this file: NO NEW RLS POLICY IS ADDED TO place_logs. Not one. The obvious
-- implementation ("create policy 'place_logs: read friends' logs' ... using
-- (private.is_friend(user_id))") is WRONG and was rejected, because an RLS
-- policy is not column-scoped: the moment such a policy exists, every friend's
-- row is visible to the ordinary PostgREST table endpoint, and
--
--     GET /place_logs?user_id=eq.<friend>&select=note,rating,status,visited_on
--
-- returns their private notes, their ratings, their wishlist and their dates.
-- RLS grants rows, never columns; the brief above is a COLUMN decision, so it
-- cannot be enforced in RLS and must not be attempted there. place_logs
-- therefore keeps its owner-only policy untouched, and the friend surface goes
-- AROUND it via SECURITY DEFINER functions whose declared return type is the
-- whitelist. See "STRUCTURAL EXCLUSION OF note AND rating" below.
--
-- ATOMIC: wrapped in begin; ... commit;. Applied by hand. A partial apply would
-- be materially worse than no apply -- e.g. the friendships table existing
-- while the user_blocks termination trigger does not, which is a state where
-- blocking someone does NOT end the friendship and they keep reading your map.
-- Nothing below is transaction-hostile: no CREATE INDEX CONCURRENTLY, no ALTER
-- TYPE ADD VALUE, no VACUUM.
--
-- RE-RUNNABLE, with five statements that are NOT self-guarding, all safe:
--   * the two `create trigger` statements are bare -- Postgres has no
--     `create trigger if not exists`. BOTH are immediately preceded by
--     `drop trigger if exists ... on ...`. Do not reorder a drop below its
--     create on the assumption that every statement guards itself.
--   * `alter table public.content_reports add constraint
--     content_reports_target_type_check ...` in the PROFILE REPORTING section is
--     bare -- there is no `add constraint if not exists`. It is immediately
--     preceded by `drop constraint if exists` naming the SAME constraint.
--   * `create view public.admin_open_content_reports` in that same section is
--     bare -- `create or replace view` cannot be used to change a view's WITH
--     options, and the `security_invoker = false` on that view is load-bearing.
--     It is immediately preceded by `drop view if exists`, and FOLLOWED by the
--     `revoke all` that a fresh CREATE makes necessary again (Supabase's default
--     privileges re-grant SELECT to anon/authenticated on every new object).
--   * `revoke` / `grant` are unconditional but idempotent by definition.
-- Everything else is `create table if not exists` / `create index if not
-- exists` / `create or replace function`. NOTE the standing caveat that comes
-- with `create table if not exists`: on a re-run against an ALREADY-CREATED
-- table it is a no-op, so a later edit to a CHECK constraint in a table body
-- here would NOT be applied by re-running this file. That is true of every
-- migration in this repo and is called out, not fixed.
--
-- STATIC REVIEW ONLY. There is no local Postgres on this machine. Nothing here
-- has been executed, EXPLAINed, or tested against a live database. Everything
-- below is a static reading of the applied SQL plus the documented behaviour of
-- the constructs used. Treat the first apply as the first execution.
--
-- DEPENDS ON:
--   20260724000001_core_schema.sql       -- profiles, places, place_logs and the
--                                           owner-only RLS this file opens
--   20260728000002_trip_collab.sql       -- trip_members, is_trip_owner()
--   20260729000001_trip_collab_hardening -- the join_attempts throttle pattern
--   20260808000001_community.sql         -- schema `private`, user_blocks,
--                                           private.is_blocked_pair(),
--                                           private.caller_content_suspended(),
--                                           the grant/revoke posture,
--                                           content_reports + its target_type
--                                           CHECK, report_attempts, plain_text(),
--                                           content_reports_sanitize(),
--                                           admin_open_content_reports,
--                                           profiles.content_suspended_at
--   20260808000003_report_rate_cap.sql   -- the per-actor abuse-cap pattern, and
--                                           the applied report_content() body
--                                           this file replaces verbatim-plus-one
--   20260828000001_visit_time_sharing    -- visit_times, visit_time_members
--                                           (NOT yet applied; ordered before
--                                            this file, so it applies first)
-- ============================================================================
begin;

-- ================================================================== tables

-- ------------------------------------------------------------- friendships
-- ONE CANONICAL ROW PER PAIR, not two mirrored rows.
--
-- WHY canonical rather than mirrored: two rows means two places for the truth
-- to live and two chances for them to disagree. Every question this feature
-- asks -- "are we friends", "who asked whom", "does a request already exist" --
-- is a question about the PAIR, and a pair is one fact. The mirrored design
-- also makes "A requests B while B requests A" produce two pending rows that
-- both have to be reconciled; here it is a primary-key collision that cannot
-- happen, and the second request is instead read as an acceptance of the first.
--
-- CANONICALISATION IS ENFORCED IN THE SCHEMA, not in the RPCs. friendships_ordered
-- (user_low < user_high) plus the primary key (user_low, user_high) together
-- make a reversed duplicate row a database-level impossibility: (B, A) with
-- B > A fails the CHECK, and (A, B) again fails the PK. No application code is
-- trusted for this, so a service-key repair or a future RPC cannot reintroduce
-- the reversed row.
--
-- SELF-FRIENDING is closed by the SAME constraint and needs no second one:
-- `user_low < user_high` is strict, so user_low = user_high is rejected. A
-- self-row would otherwise be a real hazard rather than a curiosity -- it would
-- make private.friendship_visible(me, me) true, which is harmless, but it would
-- also put the caller in their own my_friends() list and in their own incoming
-- requests, and every "am I allowed to see this person" test would start
-- answering yes for a uuid the caller supplied.
create table if not exists public.friendships (
  user_low  uuid not null references public.profiles (id) on delete cascade,
  user_high uuid not null references public.profiles (id) on delete cascade,
  -- WHO ASKED. This is what makes "X sent you a request" answerable, and it is
  -- the reason the row cannot be a bare unordered pair. It is constrained to be
  -- one of the two members below, so it can never point at a third party.
  requested_by uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at timestamptz not null default now(),
  -- Set when the request is accepted. Rendered as "friends since"; null while
  -- pending. Never exposed for a PENDING row (see my_friend_requests, which
  -- returns created_at instead).
  responded_at timestamptz,
  primary key (user_low, user_high),
  constraint friendships_ordered check (user_low < user_high),
  constraint friendships_requester_in_pair
    check (requested_by = user_low or requested_by = user_high)
);
-- WHY there is no 'declined' status even though declines must be remembered:
-- a declined request is not a relationship, it is a REFUSAL, and keeping it in
-- this table would put it in the caller's own pair row where the requester
-- could read its state back out. It lives in friend_declines below instead --
-- readable only by the DEFINER RPCs, never by the person who was declined.
-- See "THE DECLINE IS NOT AN ORACLE" in the adversarial pass.

-- The primary key's leading column serves "rows where I am user_low". The other
-- half of every my_friends() / my_friend_requests() lookup filters on user_high
-- and would otherwise be a sequential scan of the whole graph.
create index if not exists friendships_high_idx
  on public.friendships (user_high);

-- Serves exactly one query: the outbound-pending cap in request_friend(), which
-- counts rows this caller initiated that are still pending. Partial, so it
-- stays small -- accepted friendships (the overwhelming majority of rows in a
-- healthy graph) are not in it at all.
create index if not exists friendships_pending_out_idx
  on public.friendships (requested_by) where status = 'pending';

alter table public.friendships enable row level security;
-- NO POLICIES, deliberately, and this is the whole access-control story for
-- this table: RLS is on with zero policies, which denies every client read and
-- every client write outright. The four write RPCs and the two read RPCs are
-- all SECURITY DEFINER and run past RLS with the owner's privileges. Grants are
-- revoked below as an independent second layer -- see the grants block for why
-- both, and the adversarial pass for the forged-row case this closes.

-- ---------------------------------------------------------- friend_declines
-- "This person asked me and I said no." The record that makes a decline stick.
--
-- WHY THIS TABLE EXISTS: without it, decline is a button that does nothing.
-- decline_friend() deletes the pending row; the requester's next tap re-creates
-- it, and the decliner is back where they started, forever, at one request per
-- tap. That is not a friend feature, it is a notification-spam channel with a
-- consent-shaped button on it. The row here is what request_friend() reads to
-- refuse a re-send during a cooldown window.
--
-- ALSO WRITTEN BY remove_friend(), by the remover. "Unfriend, get re-requested
-- instantly, unfriend again" is the same loop with an extra step; the person
-- who ended the friendship gets the same quiet window that a decliner gets.
create table if not exists public.friend_declines (
  decliner_id  uuid not null references public.profiles (id) on delete cascade,
  requester_id uuid not null references public.profiles (id) on delete cascade,
  declined_at  timestamptz not null default now(),
  primary key (decliner_id, requester_id),
  constraint friend_declines_no_self check (decliner_id <> requester_id)
);
-- Directional ON PURPOSE, unlike user_blocks' symmetric treatment: A declining
-- B must not stop A from later reaching out to B. Changing your mind about
-- someone you turned down is a normal thing to do, and request_friend() clears
-- the row in that direction when it happens (see "consent, expressed").

alter table public.friend_declines enable row level security;
-- No policies and no grants. Only the DEFINER RPCs read or write it. If the
-- person who was declined could SELECT this table, the entire point of the
-- silent cooldown (below) would be defeated by one GET.

-- -------------------------------------------------- friend_request_attempts
-- Rate-limit ledger. Same shape and same rolling-window discipline as
-- public.join_attempts (20260729000001) and public.report_attempts
-- (20260808000001 / 20260808000003): prune this user's out-of-window rows on
-- the way in, count what remains, cap, then record.
--
-- WHY A SEPARATE LEDGER AND NOT join_attempts. 20260828000001 deliberately made
-- join_visit() SHARE join_attempts with join_trip(), and that was right there
-- for a reason that does not apply here: both of those functions probe the SAME
-- 48-bit invite-code space, so two ledgers would have handed an attacker 40
-- guesses an hour instead of 20. Friend requests probe nothing. The budget being
-- defended here is "how many strangers can one account contact per hour", which
-- is a different resource; sharing the ledger would mean a user who joined a few
-- trips could no longer add a friend, and a friend-request flood would exhaust
-- the invite-code defence's counter. Different resource, different ledger.
--
-- TWO KINDS, ONE TABLE. 'request' and 'lookup' are capped separately (10/hour
-- and 60/hour) because they are different actions with wildly different
-- legitimate volumes -- you look up several handles to find the right person,
-- but you should not be contacting ten strangers an hour -- while sharing one
-- table keeps one prune, one index and one cleanup story.
create table if not exists public.friend_request_attempts (
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null default 'request' check (kind in ('request', 'lookup')),
  attempted_at timestamptz not null default now()
);

create index if not exists friend_request_attempts_user_idx
  on public.friend_request_attempts (user_id, kind, attempted_at);

alter table public.friend_request_attempts enable row level security;
-- No policies, no grants, exactly like join_attempts and report_attempts: only
-- the DEFINER RPCs touch it, and a client has no business reading anyone's
-- contact history -- least of all their own attempt log, which would let a
-- harasser time the cap precisely.

-- ========================================================= private helpers
--
-- BOTH live in `private`, and that is the same decision 20260808000001 spelled
-- out at length: EVERY function in schema public is a PostgREST endpoint. A
-- SECURITY DEFINER function in public taking two arbitrary uuids and answering
-- truthfully about a pair the caller is not part of is an oracle over the whole
-- social graph, one POST at a time. private is not in PostgREST's exposed schema
-- list (db-schemas defaults to "public"), so nothing here is reachable as
-- POST /rpc/<name>. The fix is unreachability, not a revoke.
--
-- private.friendship_visible(a, b) is precisely that shape -- it would answer
-- "are these two strangers friends" for any pair -- and private.user_visited_rank
-- is worse: in public it would be a lookup of ANY user's played count and
-- percentile from their uuid alone, which is the single most sensitive
-- aggregate this file computes.
--
-- search_path is `public, private, pg_temp` throughout: public for the tables,
-- private so sibling helpers resolve, pg_temp LAST so a caller cannot shadow an
-- unqualified name with a temp object. Every cross-helper call is
-- schema-qualified anyway, so resolution never depends on the order.

-- THE GATE. Every read of another person's data in this file goes through this
-- one predicate, so there is exactly one place to get it right and exactly one
-- place to audit.
--
-- Both clauses are checked IN SQL, never assumed from the app:
--   (a) an ACCEPTED friendship exists between the two -- 'pending' is explicitly
--       not enough, which is the difference between "I asked you" and "you said
--       yes", and is the entire consent model of this feature;
--   (b) neither party has blocked the other -- private.is_blocked_pair() from
--       20260808000001, which is symmetric, so a block from EITHER side closes
--       the door in BOTH directions.
--
-- The block test is here as well as in the user_blocks trigger below on purpose.
-- The trigger deletes the friendship row when a block is created, so in a
-- consistent database (b) is already implied by (a) being absent. This clause is
-- what makes the surface correct even if the trigger is ever dropped, fails to
-- fire, or is bypassed by a service-key insert into user_blocks. Blocking is the
-- control that must never depend on a second control having worked.
--
-- SECURITY DEFINER is required, not decorative: friendships is RLS-locked with
-- no policies, and a caller can only ever read the half of user_blocks they
-- authored. An invoker-rights version of this predicate would answer "no" for
-- everybody, always.
create or replace function private.friendship_visible(viewer uuid, target uuid)
returns boolean language sql stable security definer
set search_path = public, private, pg_temp as $$
  select viewer is not null
     and target is not null
     and viewer <> target
     and exists (
       select 1 from public.friendships f
       where f.user_low  = least(viewer, target)
         and f.user_high = greatest(viewer, target)
         and f.status = 'accepted'
     )
     and not private.is_blocked_pair(viewer, target)
$$;
-- least()/greatest() over uuid use the type's default btree comparison, the same
-- operator the friendships_ordered CHECK uses, so the pair derived here is
-- always the pair the constraint permitted to be stored. The explicit null
-- guards matter because is_blocked_pair() returns FALSE for a null argument
-- (documented in 20260808000001): without them, a null viewer would fail the
-- exists() anyway, but relying on that is one refactor away from being wrong.

-- The percentile badge, for an arbitrary user. Mathematically identical to
-- public.my_rank() (20260728000003), which is the caller's own version and stays
-- exactly as it is; this is the same window function of the same table with the
-- target as a parameter instead of auth.uid(). Kept as a separate function
-- rather than by generalising my_rank(), because my_rank() is a shipped public
-- RPC and adding a uuid parameter to it -- even a defaulted one -- would turn
-- the already-applied endpoint into the oracle described above.
--
-- Only AGGREGATES leave this function: a count and a percentile bucket. No log
-- row, no place, no note, no rating.
create or replace function private.user_visited_rank(target uuid)
returns table (visited_count int, top_percent int)
language sql stable security definer
set search_path = public, private, pg_temp as $$
  with counts as (
    select user_id, count(*)::int as n
    from public.place_logs where status = 'visited'
    group by user_id
  ),
  me as (select coalesce((select n from counts where user_id = target), 0) as n),
  total as (select count(*)::int as c from counts)
  select
    me.n,
    case
      when me.n = 0 or total.c = 0 then 100
      else greatest(1, ceil(100.0 * ((select count(*) from counts where n > me.n) + 1) / total.c))::int
    end
  from me, total
$$;
-- A user with zero visited logs is not in `counts` at all, so they get
-- (0, 100) -- "top 100%", which is what my_rank() already renders for a new
-- account. Behaviour is identical for a friend and for yourself, deliberately:
-- the badge on a friend's card must be the same number they see on their own.

-- ============================================== blocking terminates friendship
--
-- BLOCKING DOMINATES FRIENDSHIP. Blocking someone must end any friendship with
-- them, immediately, and prevent a new request in either direction. Verified
-- against the APPLIED public.user_blocks (20260808000001): primary key
-- (blocker_id, blocked_id), user_blocks_blocked_idx on the reverse column,
-- user_blocks_no_self CHECK, RLS policies read/insert/delete own, and -- the
-- part that decides the shape of this control -- `grant select, insert, delete
-- on public.user_blocks to authenticated`. A block can therefore be created by
-- a direct PostgREST INSERT, WITHOUT going through public.block_user().
--
-- So this CANNOT be a check inside block_user(). block_user() is in an applied
-- migration and is not the only door to its own table. A trigger is a property
-- of the table and fires on every path -- the RPC, a raw POST /user_blocks, the
-- service key, psql -- which is the same reasoning 20260808000001 used to put
-- sanitization in triggers behind revoked grants.
--
-- SECURITY DEFINER is required: a trigger function runs as the INVOKING role
-- unless it is DEFINER, and the authenticated role has no privileges at all on
-- friendships (revoked below). An invoker trigger here would raise "permission
-- denied for table friendships" and would break blocking entirely -- i.e. the
-- failure mode is that a user cannot block, which is the worst possible way for
-- this to go wrong.
create or replace function public.user_blocks_end_friendship()
returns trigger language plpgsql security definer
set search_path = public, private, pg_temp as $$
begin
  -- Deletes whatever is there: accepted, or pending in either direction. The
  -- pair is canonicalised the same way everything else canonicalises it.
  delete from public.friendships
   where user_low  = least(new.blocker_id, new.blocked_id)
     and user_high = greatest(new.blocker_id, new.blocked_id);

  -- No friend_declines row is written here. The block itself is the refusal for
  -- as long as it stands (request_friend and accept_friend both consult
  -- is_blocked_pair), and if the blocker later UNBLOCKS, a fresh request from
  -- the other party is a legitimate thing to allow. Stacking a 30-day cooldown
  -- on top of an unblock would make unblocking not actually mean unblocking.
  return null;
end $$;

drop trigger if exists user_blocks_ends_friendship on public.user_blocks;
create trigger user_blocks_ends_friendship
  after insert on public.user_blocks
  for each row execute function public.user_blocks_end_friendship();
-- AFTER INSERT, statement-less, returning null: nothing downstream reads the
-- return value of an AFTER trigger. INSERT-only -- user_blocks has no UPDATE
-- policy and its only columns are the two members and a timestamp, so there is
-- no update path to guard. DELETE (unblocking) deliberately does NOT restore
-- the friendship: unblocking is not a reconciliation, and silently re-creating
-- a relationship somebody blocked their way out of would be the worst kind of
-- surprise.

-- ==================================================================== RPCs
--
-- All SECURITY DEFINER with a pinned `set search_path = public, private,
-- pg_temp`, all opening with their own auth.uid() check, all raising short
-- stable codes the mobile client switches on:
--
--   not_signed_in | not_found | already_friends | cannot_friend_self |
--   blocked | too_many_requests | not_owner | content_suspended
--
-- not_owner and content_suspended are carried over from the existing project
-- vocabulary (20260729000001 and 20260808000001 respectively) rather than
-- invented here. No other new codes.
--
-- ONE CODE IS RETURNED RATHER THAN RAISED, in exactly one function:
-- request_friend() RETURNS the string 'not_found' (its return type is already
-- text). Everywhere else -- accept_friend(), decline_friend(), remove_friend(),
-- friend_profile(), the invite RPCs -- 'not_found' is still raised. The reason
-- is the throttle: a raise rolls the attempt row back, which would make failed
-- probes free. It is argued in full at that function. The mobile client handles
-- BOTH shapes for request_friend(), the returned string and the raised
-- exception, so client and migration can ship in either order.
--
-- THE 'blocked' / 'not_found' SPLIT, stated once and applied everywhere below.
-- 20260808000001 established that a distinguishable "you are blocked" is a
-- notification the blocker never agreed to send, and made vote_trip() and
-- adopt_trip() raise 'not_found' on a block. That rule is kept, with one
-- refinement that is not a leak:
--
--   * the CALLER has blocked the target  -> 'blocked'. This is the caller's own
--     block, already readable by them via my_blocks() (20260808000002), so
--     telling them costs nothing and is the only way the app can say the useful
--     thing: "you blocked this person; unblock them first".
--   * the TARGET has blocked the CALLER  -> 'not_found', indistinguishable from
--     "no such handle". The caller learns nothing. In request_friend() BOTH of
--     those are RETURNED rather than raised, by the same statement, so that a
--     miss still consumes the throttle and so that the two remain identical to
--     each other -- see the long note at that function's handle lookup.
--
-- Parameter names are the PostgREST wire contract and are frozen. Locals are
-- prefixed v_ so nothing collides with a column name inside plpgsql.

-- ------------------------------------------------------ find_user_by_handle
-- EXACT HANDLE MATCH ONLY. No prefix search, no ILIKE, no trigram, no fuzzy
-- match, no "did you mean", and no listing.
--
-- WHY THIS IS THE DELIBERATE CHOICE AND NOT A MISSING FEATURE. profiles.handle
-- is constrained to ^[a-z0-9_]{3,24}$. A prefix search over that -- even a
-- three-character minimum, even paginated, even rate-limited -- is a user
-- directory: `?prefix=aa`, `?prefix=ab`, ... walks the entire registered user
-- base in a few thousand calls and hands an attacker every handle, display name
-- and uuid on the service. That list is the raw material for targeted
-- harassment (pick the women's names, pick the teenagers' handles), for
-- credential-stuffing correlation against other services where the same handle
-- is used, and for scraping the friend surface of anyone who ever accepts a
-- request. Exact match inverts the economics: you can only confirm a handle you
-- ALREADY KNOW, which is the real-world case this feature exists for -- someone
-- tells you their handle and you add them. The cost of the safe design is that
-- users must type the handle exactly; that is a real cost and it is worth it.
--
-- Returns ONLY what is needed to send a request: id, handle, display_name.
-- Not home_region, not the played count, not the percentile, not created_at --
-- a stranger you have not been introduced to gets a name and nothing else.
-- Those fields live behind friend_profile(), which requires acceptance.
--
-- Throttled at 60 lookups per rolling hour. Note that a MISS returns an empty
-- set and therefore RETURNS NORMALLY, so unlike the invite-code throttles
-- inherited from join_trip(), failed probes here DO consume the cap -- which is
-- the correct polarity for an enumeration defence, where the misses are the
-- attack.
--
-- PARAMETER NAME NOTE, because it looks like an inconsistency and is not one:
-- the input is `target_handle`, NOT `handle`, while request_friend() below does
-- take `handle`. RETURNS TABLE columns are OUT parameters, so a function that
-- both accepts `handle` and returns a `handle` column declares that name twice
-- and Postgres refuses to create it ("parameter name ... used more than once").
-- The OUT column keeps the natural name because it is what the mobile client
-- reads; the IN parameter is the one that moved. Wire contract:
--   POST /rpc/find_user_by_handle {"target_handle": "gavin"}
create or replace function public.find_user_by_handle(target_handle text)
returns table (id uuid, handle text, display_name text)
language plpgsql volatile security definer
set search_path = public, private, pg_temp as $$
declare
  v_handle text;
  v_recent int;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;

  -- Rolling 1-hour window, pruned on the way in so the ledger stays small. Both
  -- statements filter on user_id so they ride friend_request_attempts_user_idx.
  delete from public.friend_request_attempts
   where user_id = auth.uid() and attempted_at < now() - interval '1 hour';
  select count(*) into v_recent
    from public.friend_request_attempts
   where user_id = auth.uid() and kind = 'lookup';
  if v_recent >= 60 then raise exception 'too_many_requests'; end if;
  insert into public.friend_request_attempts (user_id, kind) values (auth.uid(), 'lookup');

  -- Normalised the same way the column CHECK is written. A handle that is not
  -- lower-case a-z0-9_ cannot exist in profiles, so a malformed input simply
  -- finds nothing -- there is no separate 'invalid_handle' code to distinguish.
  v_handle := lower(btrim(coalesce(target_handle, '')));
  if v_handle = '' then return; end if;

  return query
    select p.id, p.handle, p.display_name
      from public.profiles p
     where p.handle = v_handle
       and p.id <> auth.uid()                          -- you are not a search result
       and not private.is_blocked_pair(auth.uid(), p.id);
  -- The block filter is symmetric and returns an EMPTY SET rather than an
  -- error: to a blocked searcher, a person who blocked them is indistinguishable
  -- from a handle that was never registered. Note that a caller searching for
  -- someone THEY blocked also gets nothing here -- request_friend() is where
  -- they get the actionable 'blocked' message, because that is where they have
  -- expressed an intent to act.
end $$;

-- ---------------------------------------------------------- request_friend
-- Send a friend request by handle. Returns the resulting state of the pair --
-- 'pending', 'accepted', or 'not_found'.
--
-- 'not_found' is RETURNED, not raised, and that is a deliberate throttle
-- decision rather than an ergonomic one; the long argument is at the return
-- sites below. Every OTHER failure here still raises: not_signed_in,
-- content_suspended, too_many_requests, cannot_friend_self, blocked (meaning
-- the CALLER blocked the target), already_friends.
--
-- 'accepted' happens when the target had ALREADY requested the caller: asking
-- back is an acceptance. That is not a leak -- the caller could see the incoming
-- request in my_friend_requests() anyway -- and it removes a genuinely confusing
-- state ("we have both asked each other and are still not friends").
create or replace function public.request_friend(handle text)
returns text language plpgsql security definer
set search_path = public, private, pg_temp as $$
declare
  v_handle  text;
  v_me      uuid := auth.uid();
  v_target  uuid;
  v_low     uuid;
  v_high    uuid;
  v_status  text;
  v_by      uuid;
  v_recent  int;
  v_pending int;
begin
  if v_me is null then raise exception 'not_signed_in'; end if;

  -- A moderator-suspended account does not get to contact strangers. Same gate
  -- publish_trip() and report_condition() use (20260808000001); a suspension
  -- that left the friend-request channel open would be a suspension in name
  -- only, since friend requests are the most direct harassment vector here.
  if private.caller_content_suspended() then raise exception 'content_suspended'; end if;

  -- Throttle FIRST, matching report_content()'s placement. Rolling 1-hour
  -- window, pruned on the way in, counted BEFORE the insert so the 10th request
  -- of the hour succeeds and the 11th raises.
  delete from public.friend_request_attempts
   where user_id = v_me and attempted_at < now() - interval '1 hour';
  select count(*) into v_recent
    from public.friend_request_attempts
   where user_id = v_me and kind = 'request';
  if v_recent >= 10 then raise exception 'too_many_requests'; end if;
  insert into public.friend_request_attempts (user_id, kind) values (v_me, 'request');

  -- Standing cap on OUTBOUND PENDING requests, independent of rate. The hourly
  -- throttle limits burst; this limits accumulation. Without it, ten requests an
  -- hour, every hour, is 240 unanswered requests a day sitting in 240 strangers'
  -- inboxes -- each one a notification, each one a name and a handle the target
  -- did not ask to see. Clearing the backlog requires those people to act, which
  -- is exactly the asymmetry a harasser wants; so the cap is on the SENDER's
  -- outstanding total and it is the sender who has to wait.
  select count(*) into v_pending
    from public.friendships
   where requested_by = v_me and status = 'pending';
  if v_pending >= 30 then raise exception 'too_many_requests'; end if;

  -- EVERY 'not_found' BELOW *RETURNS*. IT DOES NOT RAISE. Read this before
  -- touching any of the three sites, because the polarity is the defence.
  --
  -- A raised exception aborts the PostgREST transaction, which rolls back the
  -- attempt row inserted above. If a miss raised, a miss would cost the prober
  -- NOTHING: they could walk handle candidates through this function at
  -- unlimited rate and only their SUCCESSES would ever consume the 10/hour cap,
  -- leaving an unmetered enumeration endpoint sitting next to the metered one.
  -- Returning normally commits the ledger row, so a miss is charged exactly
  -- like a hit. This is the polarity find_user_by_handle() already has -- a miss
  -- there returns an empty set, returns normally, and consumes the 60/hour cap
  -- -- and the two functions now agree.
  --
  -- THE not_found SITES MUST STAY INDISTINGUISHABLE FROM EACH OTHER. There are
  -- three: empty/malformed handle, unregistered handle, and "the TARGET has
  -- blocked the caller". All three return the same bare literal by the same
  -- statement, and all three leave the same database state -- the one attempt
  -- row inserted above, committed, and nothing else written on any of them.
  -- The pair that carries the security weight is the last two, because those
  -- are the two an attacker cannot tell apart on their own: same status code,
  -- same body, same cost against the cap. If one of them raised and the other
  -- returned, the DIFFERENCE between the two responses would itself be the
  -- oracle ("that handle is registered and has blocked you") that the
  -- 'blocked' / 'not_found' split in the RPC header exists to deny. So an edit
  -- to one of these three lines is an edit to all three -- do not "improve"
  -- one of them into a raise, a distinct code, or an early exit.
  --
  -- What is NOT equalised is wall-clock timing: the blocked-by-target path runs
  -- two more user_blocks probes than the unregistered-handle path. That channel
  -- predates this change, applies to every branch in this file, and is accepted
  -- under "TIMING AND SIDE-CHANNELS" in the adversarial pass; equalising it
  -- would mean doing fake work on the fast path.
  --
  -- WIRE CHANGE, SAFE IN EITHER DEPLOY ORDER: 'not_found' now arrives as HTTP
  -- 200 with the body "not_found" instead of as an error. The mobile client
  -- accepts BOTH forms -- the returned string and the older raised exception --
  -- so this migration and the client release can ship in either order.
  v_handle := lower(btrim(coalesce(handle, '')));
  if v_handle = '' then return 'not_found'; end if;

  select p.id into v_target from public.profiles p where p.handle = v_handle;
  if v_target is null then return 'not_found'; end if;
  if v_target = v_me then raise exception 'cannot_friend_self'; end if;

  -- The 'blocked' / 'not_found' split described in the RPC header. Read
  -- user_blocks directly rather than via is_blocked_pair() precisely because
  -- the two directions must produce DIFFERENT answers here.
  if exists (
    select 1 from public.user_blocks
     where blocker_id = v_me and blocked_id = v_target
  ) then
    raise exception 'blocked';
  end if;
  if exists (
    select 1 from public.user_blocks
     where blocker_id = v_target and blocked_id = v_me
  ) then
    -- Byte-identical to the unknown-handle path above, and required to be:
    -- same literal, same return, same one committed attempt row, no other
    -- write on either path. See the note above the handle lookup.
    return 'not_found';
  end if;

  v_low  := least(v_me, v_target);
  v_high := greatest(v_me, v_target);

  select f.status, f.requested_by into v_status, v_by
    from public.friendships f
   where f.user_low = v_low and f.user_high = v_high;

  if v_status is not null then
    if v_status = 'accepted' then
      -- Safe to say out loud: they are already in the caller's my_friends() list.
      raise exception 'already_friends';
    end if;

    if v_by = v_target then
      -- They asked first. This request is an acceptance.
      update public.friendships
         set status = 'accepted', responded_at = now()
       where user_low = v_low and user_high = v_high;
      -- Mutual consent clears the slate in both directions.
      delete from public.friend_declines
       where (decliner_id = v_me and requester_id = v_target)
          or (decliner_id = v_target and requester_id = v_me);
      return 'accepted';
    end if;

    -- The caller's own request is already outstanding. Idempotent no-op.
    return 'pending';
  end if;

  -- CONSENT, EXPRESSED. The caller previously declined THIS target and is now
  -- reaching out to them; that is a change of mind and it clears the caller's
  -- own refusal. Only the (me -> them) direction is cleared -- their refusal of
  -- the caller is not the caller's to erase.
  delete from public.friend_declines
   where decliner_id = v_me and requester_id = v_target;

  -- Self-pruning of the target's expired refusal, on the one path that reads it.
  -- Keeps the table's live size proportional to refusals inside the window
  -- rather than to refusals ever made.
  delete from public.friend_declines
   where decliner_id = v_target and requester_id = v_me
     and declined_at < now() - interval '30 days';

  -- THE COOLDOWN, AND WHY IT IS SILENT. If the target refused this caller within
  -- the last 30 days, nothing is inserted -- and the caller is told 'pending',
  -- the same word they get for a request that really was created.
  --
  -- This is a deliberate, uncomfortable choice, so it is stated plainly rather
  -- than buried. The honest alternative -- raising a distinct 'declined' -- turns
  -- decline into a notification the decliner never agreed to send, and hands a
  -- harasser a confirmed read receipt on the refusal. It also creates a probe:
  -- re-request in a loop and watch for the error to change. Silence makes
  -- "declined" and "still pending" indistinguishable from the sender's side,
  -- forever, which is the whole reason there is no outbound-pending read surface
  -- in this file either (see the note under my_friend_requests).
  --
  -- The attempt row above was already inserted and this path RETURNS normally,
  -- so the cooldown request still consumes the sender's hourly cap. Burning the
  -- budget of someone re-sending into a refusal is the correct behaviour.
  if exists (
    select 1 from public.friend_declines
     where decliner_id = v_target and requester_id = v_me
       and declined_at >= now() - interval '30 days'
  ) then
    return 'pending';
  end if;

  insert into public.friendships (user_low, user_high, requested_by, status)
  values (v_low, v_high, v_me, 'pending')
  on conflict (user_low, user_high) do nothing;
  -- ON CONFLICT closes the concurrent-mutual-request race: A and B each read no
  -- row, each attempt an insert, one wins on the primary key and the loser
  -- inserts nothing. Both callers are told 'pending', which is true for both --
  -- the pair is pending, initiated by whoever's insert landed. The next request
  -- from the loser takes the "they asked first" branch above and accepts it.

  return 'pending';
end $$;

-- ----------------------------------------------------------- accept_friend
-- Accept a request that was sent TO the caller. `other` is the requester.
--
-- SUSPENSION IS DELIBERATELY NOT CHECKED HERE, unlike request_friend(). This
-- was raised in review as a possible omission -- a content-suspended account
-- CAN still accept an incoming request and gain the friend read surface
-- (friend_profile, friend_places) -- so it is recorded as a decision.
--
-- The rule this file follows, stated once: private.caller_content_suspended()
-- gates OUTBOUND INITIATION, not responses to someone else's initiative. That
-- is the same line publish_trip() and report_condition() sit on (a suspension
-- stops you PUTTING things in front of people) and the same line report_content()
-- sits on from the other side (a suspended account is often the one being
-- harassed and must keep its channels). request_friend() is initiation, so it
-- is gated. accept_friend() and decline_friend() are answers, so they are not.
--
-- The concrete argument for leaving it open:
--   * A suspended account cannot SEND requests, so every request it can accept
--     was sent BY SOMEONE ELSE -- either before the suspension, or by a person
--     who knows the handle and chose to ask. The read surface it gains is one
--     the requester consented to hand over, to a specific person, by asking.
--   * Blocking acceptance punishes the REQUESTER, not the suspended account:
--     their request sits unanswered forever with no explanation the client can
--     give, since the reason belongs to the other party's moderation state and
--     surfacing it would leak it.
--   * Gating accept but not decline would push suspended users toward decline,
--     which fires the 30-day cooldown against an innocent requester.
--   * The friend surface is READ-ONLY and carries no free text. What a
--     suspension is actually for -- new content, new contact, new notifications
--     aimed at strangers -- is already closed at request_friend().
-- If a moderator needs the account fully inert rather than merely unable to
-- publish or initiate, that is the runbook's job, not this function's: see the
-- moderation runbook below, which is explicit that suspension is a PUBLISHING
-- brake and that a serious case needs the second action (neutralise the strings,
-- and if warranted delete the account, which cascades the friendships away).
create or replace function public.accept_friend(other uuid)
returns void language plpgsql security definer
set search_path = public, private, pg_temp as $$
declare
  v_me  uuid := auth.uid();
  v_hit int;
begin
  if v_me is null then raise exception 'not_signed_in'; end if;
  if other is null or other = v_me then raise exception 'cannot_friend_self'; end if;

  if exists (
    select 1 from public.user_blocks where blocker_id = v_me and blocked_id = other
  ) then
    raise exception 'blocked';
  end if;
  -- A block from the OTHER side falls through to the update below, matches
  -- nothing (the trigger deleted the row when they blocked), and surfaces as
  -- 'not_found'. No separate branch, and therefore no oracle.

  -- The predicate is the authorisation: status must still be 'pending', and
  -- requested_by must be the OTHER party. You cannot accept your own request,
  -- and there is no argument that steers this off the caller's own pair.
  update public.friendships
     set status = 'accepted', responded_at = now()
   where user_low  = least(v_me, other)
     and user_high = greatest(v_me, other)
     and status = 'pending'
     and requested_by = other;

  get diagnostics v_hit = row_count;
  -- Zero rows means: no such request, already accepted, it was the caller's own
  -- outbound request, the other account is gone, or a block killed the row. ONE
  -- error for all of them -- this function is DEFINER and can see every row, so
  -- distinguishing them would make it a probe for "does this uuid have a pending
  -- request out to me", answerable for uuids the caller was never introduced to.
  if v_hit = 0 then raise exception 'not_found'; end if;

  -- Acceptance is consent; it clears any stale refusal in either direction.
  delete from public.friend_declines
   where (decliner_id = v_me and requester_id = other)
      or (decliner_id = other and requester_id = v_me);
end $$;

-- ---------------------------------------------------------- decline_friend
-- Refuse a request sent TO the caller. `other` is the requester.
create or replace function public.decline_friend(other uuid)
returns void language plpgsql security definer
set search_path = public, private, pg_temp as $$
declare
  v_me  uuid := auth.uid();
  v_hit int;
begin
  if v_me is null then raise exception 'not_signed_in'; end if;
  if other is null or other = v_me then raise exception 'cannot_friend_self'; end if;

  -- Same predicate discipline as accept_friend: pending, and initiated by them.
  -- A caller cannot "decline" their own outbound request -- that is a withdrawal,
  -- and routing it here would let someone write a 30-day cooldown row against a
  -- person who never asked them for anything.
  delete from public.friendships
   where user_low  = least(v_me, other)
     and user_high = greatest(v_me, other)
     and status = 'pending'
     and requested_by = other;

  get diagnostics v_hit = row_count;
  if v_hit = 0 then raise exception 'not_found'; end if;
  -- Requiring a real pending row before writing a decline is what stops
  -- friend_declines from becoming a free-form, unbounded, write-anything-about-
  -- anyone table: the row can only be created about someone who contacted the
  -- caller first. It is not an oracle -- my_friend_requests() already lists
  -- exactly the pairs for which this succeeds.

  -- The refusal, remembered. Upsert rather than insert: declining the same
  -- person a second time (after their cooldown lapsed and they asked again)
  -- restarts the window rather than failing on the primary key.
  insert into public.friend_declines (decliner_id, requester_id)
  values (v_me, other)
  on conflict (decliner_id, requester_id) do update set declined_at = now();
end $$;

-- ----------------------------------------------------------- remove_friend
-- End a friendship, or withdraw the caller's own outbound request. Idempotent.
create or replace function public.remove_friend(other uuid)
returns void language plpgsql security definer
set search_path = public, private, pg_temp as $$
declare
  v_me  uuid := auth.uid();
  v_hit int;
  v_was text;
begin
  if v_me is null then raise exception 'not_signed_in'; end if;
  if other is null or other = v_me then raise exception 'cannot_friend_self'; end if;

  delete from public.friendships
   where user_low  = least(v_me, other)
     and user_high = greatest(v_me, other)
   returning status into v_was;

  get diagnostics v_hit = row_count;
  -- NO not_found. Un-friending someone you were never friends with is a no-op,
  -- exactly like unvote_trip() and unblock_user() (20260808000001). Erroring
  -- would turn this into a probe for "is this uuid in a relationship with me",
  -- and it would also make the client's "remove" button fail after a block or a
  -- deleted account -- both cases where the row is already gone and the user's
  -- intent is already satisfied.

  -- Ending an ACCEPTED friendship arms the same 30-day quiet window a decline
  -- arms, written by the person who ended it. Without this, "unfriend" is the
  -- decline loop with an extra step: remove, get re-requested within seconds,
  -- remove again, forever.
  --
  -- Deliberately NOT armed when the caller was merely WITHDRAWING their own
  -- pending request (v_was = 'pending' and the row was theirs): withdrawing
  -- your own ask says nothing about the other person and must not silently
  -- muzzle them for a month. The status check below is coarse but safe in the
  -- right direction -- it arms only on a real friendship that existed.
  if v_hit > 0 and v_was = 'accepted' then
    insert into public.friend_declines (decliner_id, requester_id)
    values (v_me, other)
    on conflict (decliner_id, requester_id) do update set declined_at = now();
  end if;
end $$;

-- ======================================================== read surfaces (own)

-- ------------------------------------------------------------- my_friends
-- The caller's accepted friends. Zero-argument by construction, exactly like
-- my_blocks() (20260808000002): there is no parameter to point at somebody
-- else, so a caller can only ever describe their own graph.
--
-- WHY A FUNCTION AND NOT A VIEW. friendships is RLS-locked with no policies and
-- revoked from every client role, and profiles is still "read own" from
-- 20260724000001 -- so a client that somehow obtained a friend's uuid could not
-- resolve it to a handle. Something DEFINER has to do the join. A definer VIEW
-- would work too, but a view is a table-shaped endpoint that accepts arbitrary
-- `?select=` and `?<col>=eq.` from the client; a function's declared return type
-- is the entire contract. For a surface whose whole job is to be exactly as wide
-- as agreed, the narrower construct wins.
--
-- The block filter is belt-and-braces behind the user_blocks trigger, for the
-- same reason friendship_visible() carries one: blocking must not depend on a
-- trigger having fired.
create or replace function public.my_friends()
returns table (
  friend_id uuid,
  handle text,
  display_name text,
  home_region text,
  since timestamptz
)
language sql stable security definer
set search_path = public, private, pg_temp as $$
  select
    case when f.user_low = auth.uid() then f.user_high else f.user_low end as friend_id,
    p.handle,
    p.display_name,
    p.home_region,
    coalesce(f.responded_at, f.created_at) as since
  from public.friendships f
  join public.profiles p
    on p.id = case when f.user_low = auth.uid() then f.user_high else f.user_low end
  where auth.uid() is not null
    and f.status = 'accepted'
    and (f.user_low = auth.uid() or f.user_high = auth.uid())
    and not private.is_blocked_pair(
          auth.uid(),
          case when f.user_low = auth.uid() then f.user_high else f.user_low end)
  order by p.handle
$$;
-- `auth.uid() is not null` is explicit rather than implied: with no JWT both
-- halves of the OR are null, the filter matches nothing and the result is empty
-- anyway, but stating it means an anonymous caller gets an empty set for a
-- reason that survives an edit to the join.
--
-- home_region is here because the owner allowed it and the friends list renders
-- "Portland, OR" under each name. It is the coarsest location fact in the
-- schema (a free-text region on profiles the user typed themselves) and it is
-- NOT derived from any log, tee time or trip.

-- ------------------------------------------------------ my_friend_requests
-- INCOMING pending requests only -- the "X sent you a request" list. Answerable
-- precisely because friendships records requested_by.
create or replace function public.my_friend_requests()
returns table (
  requester_id uuid,
  handle text,
  display_name text,
  requested_at timestamptz
)
language sql stable security definer
set search_path = public, private, pg_temp as $$
  select
    f.requested_by,
    p.handle,
    p.display_name,
    f.created_at
  from public.friendships f
  join public.profiles p on p.id = f.requested_by
  where auth.uid() is not null
    and f.status = 'pending'
    and f.requested_by <> auth.uid()                        -- incoming only
    and (f.user_low = auth.uid() or f.user_high = auth.uid())
    and not private.is_blocked_pair(auth.uid(), f.requested_by)
  order by f.created_at desc
$$;
-- THERE IS DELIBERATELY NO my_sent_friend_requests(). It was written and then
-- removed, and the reason is the one control in this file that would otherwise
-- be silently undone: the whole point of the silent decline cooldown in
-- request_friend() is that "declined" and "still pending" are indistinguishable
-- to the sender. An outbound-pending list is exactly the oracle that breaks
-- that -- the sender watches their own list and the entry VANISHES the moment
-- they are declined, so decline becomes a read receipt after all. The client
-- already learns the state it needs from request_friend()'s return value at the
-- moment of sending and can cache it locally; a server-side outbound list would
-- buy a refresh-survives-restart nicety at the cost of the feature's main
-- privacy property. If it is ever added, it MUST also surface still-declined
-- pairs as 'pending' or the cooldown's silence is worthless.

-- ================================================== THE FRIEND READ SURFACE
--
-- STRUCTURAL EXCLUSION OF note AND rating -- how it is guaranteed, not hoped:
--
--  1. NO NEW RLS POLICY ON place_logs. The table's only policy is still
--     "place_logs: crud own" (auth.uid() = user_id), so GET /place_logs returns
--     the caller's own rows and nothing else, for any `select=` they can craft.
--     A friend's row is not merely column-filtered on that endpoint; it is not
--     visible at all. This is the load-bearing control and it is a control by
--     OMISSION -- the thing that keeps it true is that nobody adds the policy.
--     If you are reading this while adding one: don't. Add a column to
--     friend_places() instead, where the whitelist is explicit.
--  2. NO NEW GRANT on place_logs. Its privileges are untouched by this file.
--  3. NO VIEW over place_logs is created. A view would be a table-shaped
--     PostgREST endpoint with a filterable, embeddable surface; the only reason
--     it could not leak note/rating is that they were absent from the view
--     body, which is a weaker guarantee than the next point.
--  4. friend_places() DECLARES ITS RETURN TYPE COLUMN BY COLUMN as
--     (place_id, slug, name, city, region). This is an ANONYMOUS RECORD type,
--     not `setof public.place_logs` and not `setof` any table. Two consequences:
--     a client's `select=` can only ever narrow that list, never widen it (there
--     is no note or rating column in the result set to name); and PostgREST
--     resource embedding works off foreign-key metadata between real relations,
--     of which an ad-hoc record type has none -- so `?select=*,place_logs(note)`
--     has no relationship to traverse and is rejected rather than resolved.
--  5. The function BODY never selects l.note or l.rating. The place_logs alias
--     contributes exactly two things to the query: a filter (user_id, status)
--     and a join key (place_id). Every projected column comes from
--     public.places, which is a PUBLIC catalog readable by everyone already
--     ("places: public read", using (true)).
--
--  Point 4 is the structural one and point 5 is the reason there is nothing to
--  structure around. Together: to leak a note through this surface you would
--  have to edit the function's RETURN TYPE, which is a visible, reviewable
--  signature change that also breaks the mobile client's generated types.

-- ------------------------------------------------------------ friend_profile
-- The header of a friend's card: who they are, how many places they have
-- played, and their percentile badge. One row, or 'not_found'.
create or replace function public.friend_profile(friend uuid)
returns table (
  id uuid,
  handle text,
  display_name text,
  home_region text,
  visited_count int,
  top_percent int
)
language plpgsql stable security definer
set search_path = public, private, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;

  -- THE GATE. Accepted friendship AND no block in either direction, checked in
  -- SQL, never assumed from the app. A pending requester fails this. A declined
  -- one fails it. A removed ex-friend fails it the instant the row is deleted.
  -- A blocked ex-friend fails it twice over.
  if not private.friendship_visible(auth.uid(), friend) then
    raise exception 'not_found';
  end if;
  -- 'not_found' for every failure -- not a friend, blocked, or no such user --
  -- so this is not a probe for "does this uuid exist" or "did they block me".

  return query
    select p.id, p.handle, p.display_name, p.home_region, r.visited_count, r.top_percent
      from public.profiles p
      cross join lateral private.user_visited_rank(p.id) r
     where p.id = friend;
end $$;
-- visited_count is a COUNT and top_percent is a bucket. Neither can be inverted
-- into an individual log: the count is the same number friend_places() returns
-- rows for, and the percentile is derived from every user's count, not from any
-- one place, rating or note.

-- ------------------------------------------------------------- friend_places
-- The pins. Every place the friend has VISITED, place identity only.
create or replace function public.friend_places(friend uuid)
returns table (
  place_id uuid,
  slug text,
  name text,
  city text,
  region text
)
language plpgsql stable security definer
set search_path = public, private, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if not private.friendship_visible(auth.uid(), friend) then
    raise exception 'not_found';
  end if;

  return query
    select pl.id, pl.slug, pl.name, pl.city, pl.region
      from public.place_logs l
      join public.places pl on pl.id = l.place_id
     where l.user_id = friend
       and l.status = 'visited'
     order by pl.name;
end $$;
-- `status = 'visited'` is the wishlist fence. A 'want' row contributes nothing:
-- not a pin, not a count, not a row, not a difference an observer could measure.
-- The FORBIDDEN list said "anything about places they have logged but not
-- visited", and the filter is the whole of that -- there is no second surface
-- where a 'want' row appears.
--
-- visited_on is NOT projected. It was in place_logs and it is a date the person
-- was at a physical location; the allowed list said slug/name/city/region and a
-- date is not identity. Nothing here says WHEN.
--
-- place_id (public.places.id) IS projected, and that is an addition to the
-- literal "slug/name/city/region" wording, flagged rather than smuggled: the
-- mobile map needs a stable key to join these rows onto the place rows it
-- already holds, and public.places is world-readable ("places: public read",
-- using (true)) so the uuid discloses nothing that slug does not. If the mobile
-- side would rather key on slug, drop the column -- nothing else depends on it.
--
-- INDEX NOTE: this rides place_logs_user_idx (user_id) from 20260724000001,
-- which is the leading column of the filter. No new index is created; the
-- partial place_logs_place_rating_idx from 20260808000001 does not serve this
-- query (wrong leading column) and is untouched.

-- ================================================== friend-based invites
--
-- Replacing code-only sharing with "pick a friend". BOTH existing invite-code
-- paths -- join_trip(code) from 20260729000001 and join_visit(code) from
-- 20260828000001 -- are UNCHANGED and keep working: this file does not redefine
-- them, does not touch their throttle ledger, and does not alter invite_code on
-- either table. These two functions are an ADDITIONAL door that creates the
-- SAME membership rows the code path creates, so a friend-invited member and a
-- code-joined member are indistinguishable downstream and no consumer needs to
-- learn a second concept.
--
-- OWNER-ONLY, ACCEPTED-FRIENDS-ONLY, IDEMPOTENT, in that order:
--   * owner-only, because handing out membership is an ownership decision.
--     Membership on trip_plans carries UPDATE rights via "trip_plans: update own
--     or member" (20260728000002), so "any member may invite" would be a
--     privilege-escalation ladder: one invitee adds two friends, who add four.
--     is_trip_owner()-equivalent checks are inline here rather than via the
--     applied helper, so the ownership test is visible at the point of use.
--   * accepted-friends-only via private.friendship_visible(), which also
--     enforces the block rule -- you cannot invite someone who blocked you, and
--     you cannot invite someone you blocked.
--   * idempotent via ON CONFLICT DO NOTHING and a void return. Inviting the same
--     friend twice is a no-op that succeeds, which is what the brief asked for
--     and a deliberate divergence from join_visit()'s 'already_member': that
--     error exists so a person scanning a code learns why nothing happened, and
--     it has no analogue when the OWNER is the actor.
--
-- Both are SECURITY DEFINER because neither membership table can be written by
-- the client at all: trip_members has no INSERT policy (20260728000002), and
-- visit_time_members has INSERT explicitly revoked (20260828000001).

-- ------------------------------------------------------ invite_friend_to_trip
create or replace function public.invite_friend_to_trip(trip uuid, friend uuid)
returns void language plpgsql security definer
set search_path = public, private, pg_temp as $$
declare v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'not_signed_in'; end if;

  if not exists (
    select 1 from public.trip_plans t where t.id = trip and t.user_id = v_me
  ) then
    raise exception 'not_owner';
  end if;
  -- 'not_owner' for a trip that is not yours AND for a trip that does not
  -- exist. Same string, so this is not an existence probe for trip uuids.

  if not private.friendship_visible(v_me, friend) then
    raise exception 'not_found';
  end if;
  -- 'not_found' covers not-a-friend, only-pending, blocked either way, and no
  -- such account. The owner learns nothing about a uuid they were not given.

  insert into public.trip_members (trip_id, user_id) values (trip, friend)
  on conflict do nothing;
  -- Exactly the row join_trip() writes -- same table, same two columns, same
  -- default created_at. Nothing marks it as friend-originated, because nothing
  -- downstream should treat it differently.
end $$;
-- WHAT THIS GRANTS, stated because it is more than it looks: a trip member can
-- SELECT the whole trip_plans row (policy "trip_plans: read as member"), which
-- INCLUDES invite_code, and can UPDATE the trip (policy "trip_plans: update own
-- or member"). That is pre-existing behaviour of trip membership, identical to
-- what a code-join confers, and this function does not widen it -- but it does
-- mean inviting a friend to a trip hands them a re-shareable credential for it.
-- The owner's revocation is rotate_invite_code() (20260729000001) plus deleting
-- the member row, which "trip_members: leave or remove" already permits the
-- owner to do.

-- ----------------------------------------------------- invite_friend_to_visit
create or replace function public.invite_friend_to_visit(visit uuid, friend uuid)
returns void language plpgsql security definer
set search_path = public, private, pg_temp as $$
declare v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'not_signed_in'; end if;

  if not exists (
    select 1 from public.visit_times v where v.id = visit and v.user_id = v_me
  ) then
    raise exception 'not_owner';
  end if;

  if not private.friendship_visible(v_me, friend) then
    raise exception 'not_found';
  end if;

  insert into public.visit_time_members (visit_id, user_id) values (visit, friend)
  on conflict do nothing;
  -- Exactly the row join_visit() writes. travel_minutes is left NULL, which is
  -- the "add your travel time" state every member starts in -- the inviter does
  -- not and cannot set it on the invitee's behalf (set_travel_minutes() takes no
  -- user argument, 20260828000001).
end $$;
-- WHAT THIS GRANTS, and what it does NOT. The invitee gains a visit_time_members
-- row, which under my_visit_times means they see the place, the time, the member
-- count and their OWN travel_minutes. They do NOT see the invite_code (masked to
-- non-owners in that view), any other member's identity, or any other member's
-- travel_minutes -- 20260828000001's "visit_time_members: read own" policy has
-- no owner-reads-all clause and this file does not add one.
--
-- WHAT THE INVITER DISCLOSES BY INVITING: that they will be at a specific place
-- at a specific time. That is the feature, it is owner-initiated per invitation,
-- and it is the same disclosure the invite code already made -- but it is worth
-- naming in a file about privacy. See the adversarial pass, row "location".

-- ========================================================= PROFILE REPORTING
-- A profile is now user-generated content that OTHER PEOPLE SEE, so it needs a
-- report path. Until this file it did not: report_content() accepted exactly
-- 'trip' and 'condition_report' and that was COMPLETE, because those were the
-- only two things one user could ever see another user author.
--
-- WHAT CHANGED. profiles.handle and profiles.display_name are free text the
-- user types (handle ~ '^[a-z0-9_]{3,24}$', display_name 1-50 chars -- both
-- constraints on SHAPE, neither on CONTENT; a 24-character slur satisfies the
-- handle regex). Before this migration those two strings were visible only to
-- their owner ("profiles: read own"). This file publishes them to: my_friends(),
-- my_friend_requests() (so an INCOMING request delivers the sender's handle and
-- display_name to someone who never consented to hear from them), friend_profile(),
-- and find_user_by_handle() -- which hands them to ANYONE who knows the handle,
-- friend or not. The adversarial pass makes the point that a friend request
-- "cannot carry an insult" because there is no free-text field in one. That is
-- true of the REQUEST and false of the SENDER: the handle and display_name ARE
-- the free text, and they ride along with every request.
--
-- WHY BLOCKING IS NOT THE ANSWER. block_user() hides the offender from ONE
-- person, tells the operator NOTHING, and leaves the same handle in front of
-- everyone else. It is a personal mute, not a moderation signal. App Review
-- guideline 1.2 asks for a mechanism to report objectionable USER-GENERATED
-- CONTENT and the moderation runbook's 24h SLA runs off content_reports; with
-- no 'profile' target type, a complaint about a handle had nowhere to land and
-- the queue could not show it. Blocking and reporting are complementary and the
-- app should offer both on the same sheet.
--
-- THE CONSTRAINT NAME, confirmed by reading the APPLIED file rather than
-- guessing. 20260808000001_community.sql declares it INLINE and ANONYMOUS:
--     target_type text not null check (target_type in ('trip','condition_report'))
-- A column-level CHECK with no `constraint <name>` clause is auto-named by
-- Postgres as <table>_<column>_check, so the constraint actually sitting in
-- production is:
--     content_reports_target_type_check
-- That is the name dropped below. Re-validated (not re-declared) by
-- 20260808000003, which only replaced the function.
--
-- WHY DROP-AND-ADD IS SAFE ON A LIVE TABLE WITH ROWS. The new predicate is a
-- strict SUPERSET of the old one: every value the old CHECK admitted, the new
-- one admits. Every existing row therefore satisfies it by construction and the
-- implicit validation scan cannot fail -- which is why this is written as a
-- plain `add constraint` and not `... not valid` + `validate constraint`. The
-- widening also cannot be exploited by a direct write: content_reports still has
-- `revoke all` + an explicit `revoke insert` against anon and authenticated
-- (20260808000001), so report_content() below remains the only write path and
-- the CHECK is a backstop, not the gate. RE-RUNNABLE via `drop constraint if
-- exists` naming the same constraint immediately before the bare `add`.
-- (This is also why the widening is done HERE with an ALTER rather than by
-- editing the applied file's `create table` body: that file is applied, and a
-- `create table if not exists` re-run would not reach a CHECK inside it -- the
-- caveat spelled out in this file's header.)
alter table public.content_reports
  drop constraint if exists content_reports_target_type_check;
alter table public.content_reports
  add constraint content_reports_target_type_check
  check (target_type in ('trip', 'condition_report', 'profile'));

-- ------------------------------------------------------------ report_content
-- REPLACES the 20260808000003 version. The SIGNATURE IS BYTE-FOR-BYTE THE SAME
-- -- (target_type text, target_id uuid, reason text) returns void -- so
-- `create or replace function` genuinely replaces it (a changed argument list
-- would CREATE A SECOND OVERLOAD and leave the narrow one callable, which is
-- the failure mode this note exists to prevent), and the mobile client's
-- existing wire call
--     POST /rpc/report_content {"target_type","target_id","reason"}
-- is unchanged. apps/mobile/src/lib/data.ts useReportContent() needs NO change
-- to keep working.
--
-- EVERY EXISTING GUARD IS CARRIED OVER, in the same order, from the applied
-- 20260808000003 body:
--   1. auth.uid() null check -> 'not_signed_in'
--   2. the per-reporter flood cap over report_attempts: prune this user's rows
--      older than the rolling 1 hour, count what remains, raise
--      'too_many_reports' at >= 20, then record the attempt. Count BEFORE the
--      insert, so the 20th report of the hour succeeds and the 21st raises.
--      now() is the DB clock; no client timestamp is trusted.
--   3. the target-type whitelist -> 'invalid_target' (now three values)
--   4. sanitisation: left(coalesce(plain_text(reason),''), 500)
--   5. the target-existence check -> 'not_found'
--   6. the one-report-per-target upsert, ON CONFLICT ON CONSTRAINT
--      content_reports_one_per_target DO NOTHING
-- Two additions and one hardening, all called out so a diff reviewer can see
-- there is nothing else:
--   ADD (a) 'profile' in the whitelist, with its existence check against
--           public.profiles.
--   ADD (b) the self-report refusal, see below.
--   HARDENING the DEFINER header's pinned search_path goes from `public` to
--           `public, private, pg_temp` -- the canonical form used by every
--           function in this file and by 20260808000001's helpers. `public`
--           still resolves FIRST, so every unqualified name in the carried-over
--           body resolves to exactly the object it resolved to before; the
--           change only appends `private` (which holds no object sharing a name
--           with anything referenced here) and pins pg_temp LAST. Pinning
--           pg_temp last is the point: `set search_path = public` alone leaves
--           pg_temp implicitly FIRST, so a temp object could shadow an
--           unqualified name inside a SECURITY DEFINER function. Every table
--           and function reference below is ALSO schema-qualified, so neither
--           layer is load-bearing alone.
--
-- SELF-REPORT (add b). `report_content('profile', <my own id>, ...)` is refused
-- with 'own_profile'. Reporting yourself is pointless and it is queue pollution:
-- the 24h SLA is measured over open rows, and a bored user filing against their
-- own handle costs the operator a real review. It is checked BEFORE the
-- existence probe -- auth.uid() is always a live profile, so the probe would
-- have said "exists" and filed the row. Scoped to 'profile' DELIBERATELY:
-- reporting your OWN trip or condition report is still allowed, exactly as it
-- was before this file, because that is a plausible "please delete this, I
-- cannot" channel and changing it would be a behaviour change outside this
-- migration's brief.
--
-- 'own_profile' IS A NEW ERROR CODE, joining the list in 20260808000001:
--   not_signed_in | not_owner | not_found | own_report | own_trip |
--   cannot_block_self | note_too_long | invalid_kind | invalid_title |
--   invalid_target | too_many_reports | content_suspended | own_profile
-- It is deliberately NOT folded into the existing 'own_report' (which means
-- "you endorsed your own condition report") or 'invalid_target' (which means
-- "that is not a reportable type"); conflating either would mislead whoever
-- reads it in a log. The mobile client needs no mapping for it to be SAFE --
-- an unmapped code surfaces as the generic error string -- and should simply
-- not draw a Report control on the caller's own profile.
--
-- SUSPENSION IS NOT CHECKED HERE, and that is inherited, not overlooked.
-- private.caller_content_suspended() gates PUBLISHING (publish_trip,
-- report_condition, request_friend). Reporting is not publishing: a suspended
-- account is often exactly the account being harassed, and taking away its
-- ability to report would be the wrong direction. The applied version did not
-- check it either; this preserves that.
--
-- BLOCKING IS NOT CHECKED HERE EITHER, and must not be. If
-- private.is_blocked_pair() gated reporting, an abuser could pre-emptively
-- block their target to make themselves unreportable -- a one-tap immunity.
-- You can block AND report the same person, which is the normal sequence.
create or replace function public.report_content(target_type text, target_id uuid, reason text)
returns void language plpgsql security definer
set search_path = public, private, pg_temp as $$
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
  -- the hour succeed and the 21st raise. Carried over verbatim.
  delete from public.report_attempts
    where user_id = auth.uid() and attempted_at < now() - interval '1 hour';
  select count(*) into recent from public.report_attempts where user_id = auth.uid();
  if recent >= 20 then raise exception 'too_many_reports'; end if;
  insert into public.report_attempts (user_id) values (auth.uid());

  if v_type not in ('trip', 'condition_report', 'profile') then raise exception 'invalid_target'; end if;

  -- You cannot report yourself. Before the existence probe on purpose: the
  -- caller's own id ALWAYS exists, so this is the only place it can be caught.
  if v_type = 'profile' and v_target = auth.uid() then raise exception 'own_profile'; end if;

  v_reason := left(coalesce(public.plain_text(reason), ''), 500);

  -- Confirm the target exists so the queue cannot be filled with uuids that
  -- point at nothing. DEFINER is what makes this possible: the reporter cannot
  -- read trip_plans, condition_reports, or another user's profiles row directly
  -- ("profiles: read own" is still the only select policy on profiles, and this
  -- file adds none).
  if v_type = 'trip' then
    select exists (select 1 from public.trip_plans where id = v_target) into v_exists;
  elsif v_type = 'condition_report' then
    select exists (select 1 from public.condition_reports where id = v_target) into v_exists;
  else
    select exists (select 1 from public.profiles where id = v_target) into v_exists;
  end if;
  if not v_exists then raise exception 'not_found'; end if;

  insert into public.content_reports (reporter_id, target_type, target_id, reason)
  values (auth.uid(), v_type, v_target, nullif(v_reason, ''))
  on conflict on constraint content_reports_one_per_target do nothing;
  -- One report per user per target. Repeat submissions are silently absorbed
  -- so the UI can stay dumb and one user cannot inflate a queue.
end $$;
-- NOTHING IS DISCLOSED TO THE REPORTED USER. Verified against every path a
-- reportee could read, because a report that is visible to its subject is a
-- retaliation trigger, not a safety feature:
--   * content_reports has NO select policy (20260808000001) and `revoke all`
--     against anon and authenticated. Neither the reporter nor the reportee can
--     read the queue at all -- not their own rows, not rows about them.
--   * The write goes to content_reports and report_attempts ONLY. The reportee's
--     profiles row is READ (the existence probe) and never written: no counter,
--     no flag, no timestamp, and specifically NOT content_suspended_at, which
--     stays a human decision. Nothing the reportee can select changes.
--   * No friendship state moves. Reporting is not blocking and not unfriending:
--     if the two are friends, they stay friends and the reporter keeps appearing
--     in the reportee's my_friends(). The app should offer Block next to Report
--     for the user who wants both, but the two are independent calls.
--   * No notification is created; this file creates no notification rows at all.
--   * The 'own_profile' path raises before any write, so it is not even an
--     attempt row.
-- The reportee learns nothing until a HUMAN acts, which is the design.

-- ---------------------------------------------- admin_open_content_reports
-- The moderator's view has to resolve a 'profile' target or the queue shows a
-- row with a bare uuid and no way to see WHAT was reported -- which for a handle
-- complaint is the entire content. Rebuilt to match what it already does for
-- the other two types, changing nothing about them:
--   author_id      the reported profile IS the author  -> pr.id
--   author_handle                                      -> pr.handle
--   content_title  the offending string itself         -> pr.handle
--   content_body   the other offending string          -> pr.display_name
--   target_deleted extended to `and pr.id is null`
-- The target_deleted extension is semantics-preserving for the existing types,
-- not just compatible: for a 'trip' or 'condition_report' row the new pr join is
-- always NULL (its ON clause tests r.target_type = 'profile'), so the added
-- conjunct is `and true` there and those rows evaluate exactly as before. For a
-- 'profile' row whose account has since been deleted, t/c/pr are all NULL and it
-- correctly reads true -- the same "the thing you are being asked to judge is
-- already gone" signal the other two types give. Note deletion here means the
-- ACCOUNT is gone (profiles cascades from auth.users), not that the handle was
-- reset; a reset handle shows as a live row with new text, which is why the
-- reason column matters -- see the runbook note below.
--
-- DROP + CREATE rather than CREATE OR REPLACE: `create or replace view` cannot
-- change a view's WITH options, and `security_invoker = false` on this view is
-- load-bearing (it is what lets the service key read across profiles,
-- trip_plans and condition_reports). Dropping is safe -- no other object depends
-- on this view; grep the tree, it is referenced only from runbook comments --
-- and the whole file is one transaction, so the queue is never missing outside
-- it. The `revoke all` after it is MANDATORY, not decorative: a fresh CREATE
-- picks up Supabase's default privileges, which would hand this view -- which
-- joins reporter identity to reported content, exactly what the no-select-policy
-- on content_reports exists to hide -- to anon and authenticated.
drop view if exists public.admin_open_content_reports;
create view public.admin_open_content_reports
with (security_invoker = false) as
  select
    r.id,
    r.created_at,
    r.target_type,
    r.target_id,
    r.reason,
    r.reporter_id,
    rp.handle as reporter_handle,
    coalesce(t.user_id, c.user_id, pr.id) as author_id,
    coalesce(ap.handle, cp.handle, pr.handle) as author_handle,
    case r.target_type
      when 'trip' then coalesce(t.publish_title, t.title)
      when 'condition_report' then c.kind
      when 'profile' then pr.handle
    end as content_title,
    case r.target_type
      when 'trip' then coalesce(t.publish_summary, t.itinerary ->> 'summary')
      when 'condition_report' then c.note
      when 'profile' then pr.display_name
    end as content_body,
    (t.id is null and c.id is null and pr.id is null) as target_deleted
  from public.content_reports r
  left join public.profiles rp on rp.id = r.reporter_id
  left join public.trip_plans t
    on r.target_type = 'trip' and t.id = r.target_id
  left join public.condition_reports c
    on r.target_type = 'condition_report' and c.id = r.target_id
  left join public.profiles pr
    on r.target_type = 'profile' and pr.id = r.target_id
  left join public.profiles ap on ap.id = t.user_id
  left join public.profiles cp on cp.id = c.user_id
  where r.resolved_at is null
  order by r.created_at;

revoke all on public.admin_open_content_reports from anon, authenticated;

-- ============================ moderation runbook: WHAT TO DO ABOUT A PROFILE
-- The honest answer to "we have content_suspended_at, is that enough": NO, NOT
-- ON ITS OWN, and this is the operational gap this section exists to name.
--
-- SUSPENSION STOPS FUTURE POSTING. IT DOES NOT CHANGE PAST TEXT. Setting
-- profiles.content_suspended_at makes private.caller_content_suspended() true,
-- which publish_trip(), report_condition() and request_friend() honour -- so a
-- suspended account cannot publish, cannot file condition reports, and cannot
-- send new friend requests. It does NOTHING to the handle or display_name that
-- were reported. Those strings STAY EXACTLY WHERE THEY WERE: in the friend lists
-- and friend profiles of everyone who already accepted, in any pending request
-- rows that were sent before the suspension, and in find_user_by_handle() for
-- anyone who knows the handle. A suspended account with a slur for a handle is
-- still a slur on every one of its friends' screens, forever. Suspension is a
-- PUBLISHING brake, and a handle is not published -- it is displayed.
--
-- SO A PROFILE REPORT USUALLY NEEDS TWO ACTIONS, in this order. Service key,
-- SQL editor, one transaction:
--
--   begin;
--   -- 1. neutralise the offending strings. This is the part suspension misses.
--   --    Reset to a value that satisfies the shape constraints and identifies
--   --    nobody. handle is UNIQUE and matches ^[a-z0-9_]{3,24}$; using the id
--   --    keeps it collision-free. display_name may be set to NULL (nullable);
--   --    the friend surfaces already tolerate a null display_name.
--   update public.profiles
--      set handle = 'user_' || left(replace(id::text, '-', ''), 18),
--          display_name = null,
--          content_suspended_at = now()   -- 2. stop them re-posting
--    where id = '<author_id from the view>';
--   -- 3. close the report out.
--   update public.content_reports
--      set resolved_at = now(), resolution = 'profile_reset'
--    where id = '<report id>';
--   commit;
--
-- WHY THE RESET USES THE id AND NOT A COUNTER: `handle` is UNIQUE, so a fixed
-- replacement collides on the second offender. left(replace(id::text,'-',''),18)
-- is 18 hex chars, is unique because the uuid is, and 'user_' + 18 = 23
-- characters, inside the 24-character cap and inside [a-z0-9_].
--
-- THE OFFENDER CAN CHANGE IT BACK, and this is the sharp edge. authenticated
-- holds `grant update (handle, display_name, home_region, niche_id)` on profiles
-- (20260808000001) and "profiles: update own", and NOTHING in that grant is
-- conditioned on content_suspended_at -- suspension gates the RPCs, not the
-- table. So a suspended user can PATCH /profiles?id=eq.<me> and set the handle
-- straight back. If a reset is reversed, the escalation is to ban the account at
-- the auth layer (Supabase dashboard -> Authentication -> the user -> Ban), which
-- is the only control that stops it, or to revoke the column grant globally --
-- which would break every legitimate user's ability to edit their own profile
-- and is NOT recommended as a first response. A per-account editing freeze does
-- not exist in this schema; if repeat resets become a real pattern, the right
-- fix is a `where content_suspended_at is null` clause in the profiles update
-- policy, and that is a deliberate migration, not a runbook step.
--
-- WHEN SUSPENSION ALONE IS ENOUGH: when the reported profile is merely a
-- repeat-offender's account and the handle itself is unobjectionable (the
-- reason text will say so). When a RESET ALONE is enough: a one-off tasteless
-- handle from an otherwise clean account. Read the reason; the view shows it.
--
-- KEEP THE EVIDENCE. Record the offending handle/display_name (copy them out of
-- the view BEFORE the update) into the resolution text or your own notes. Once
-- reset, admin_open_content_reports shows the NEW handle for that row, and the
-- report row itself stores only target_id -- there is no snapshot of what the
-- string was. This is the same trade content_reports already makes for deleted
-- trips, and it matters more here because a profile is edited rather than
-- deleted.
--
-- NOTE ON docs/moderation-runbook.md: that document is written against a
-- content_reports shape THAT DOES NOT EXIST (columns reported_at, trip_id,
-- condition_report_id, status; tables public.trips, auth.users.is_banned) and
-- its queries will not run against the applied schema, independent of this
-- migration. The authoritative queue query is the curl against
-- admin_open_content_reports in 20260808000001. That doc needs a rewrite to
-- match the real schema AND a new section for profile reports; it is not
-- rewritten here because this file is SQL and that is a docs change.

-- ================================================================== grants
-- Supabase's default privileges hand SELECT -- and on tables, more -- to anon
-- and authenticated on every new object, so each one below is revoked
-- explicitly. Without that, RLS would be the only barrier and a single future
-- policy mistake would expose the whole social graph.
--
-- ALL THREE TABLES GET **NO CLIENT PRIVILEGES AT ALL**. Not SELECT, not INSERT.
-- This is stricter than visit_time_members (which keeps SELECT) and stricter
-- than user_blocks (which keeps insert/delete), and the reason is that every
-- legitimate read of these tables needs a join to profiles -- which is still
-- "read own" -- so a raw SELECT would return columns of uuids that resolve to
-- nothing useful while handing out the shape of the graph. The DEFINER
-- functions above are the complete interface to these three tables.
revoke all on public.friendships from anon, authenticated;
revoke all on public.friend_declines from anon, authenticated;
revoke all on public.friend_request_attempts from anon, authenticated;

-- Explicit re-revoke of the write privileges specifically, so the intent
-- survives someone adding a role-level grant in six months without reading this
-- block. A forged friendship row is the highest-value write in this schema: a
-- successful `POST /friendships {user_low: <them>, user_high: <me>, status:
-- "accepted", requested_by: <them>}` would fabricate consent and open the log
-- surface for a stranger. Two independent layers stop it -- RLS on with no
-- policies (a policy fact) and no privilege (a grant fact) -- and neither is
-- load-bearing alone.
revoke insert, update, delete on public.friendships from anon, authenticated;
revoke insert, update, delete on public.friend_declines from anon, authenticated;
revoke insert, update, delete on public.friend_request_attempts from anon, authenticated;

-- place_logs, places, profiles, user_blocks, trip_members, trip_plans,
-- visit_times, visit_time_members, content_reports and report_attempts
-- privileges are DELIBERATELY UNTOUCHED by this file. Nothing here widens an
-- existing grant or adds a policy to an existing table. The changes to existing
-- objects are exactly four, all listed so this claim can be checked against the
-- diff:
--   1. one AFTER INSERT trigger on user_blocks, which only deletes rows in the
--      new friendships table;
--   2. content_reports_target_type_check widened by one allowed value. A CHECK
--      is not a privilege and not a policy: it can only ever REFUSE rows, so
--      widening it cannot expose anything, and content_reports keeps its
--      `revoke all` + explicit `revoke insert` so no client can reach the table
--      to test the new value except through report_content();
--   3. report_content() replaced -- same signature, same guards, one more
--      accepted target type plus a self-report refusal;
--   4. admin_open_content_reports dropped and recreated, with its `revoke all
--      from anon, authenticated` re-issued immediately after the CREATE (a
--      fresh view picks Supabase's default grants back up -- see that section).
-- profiles gains NO policy and NO grant here. The 'profile' existence probe and
-- the moderator view read it through SECURITY DEFINER only; "profiles: read
-- own" is still the only select policy on that table.

-- EXECUTE on functions is granted to PUBLIC by default, which is what we want
-- for the authenticated role: every public function above opens with its own
-- auth.uid() check (the two `language sql` read surfaces express the same test
-- as an `auth.uid() is not null` predicate), so an anon call gets
-- 'not_signed_in' or an empty set and nothing else. The two private.* helpers
-- are unreachable from PostgREST regardless of EXECUTE.
--
-- public.user_blocks_end_friendship() is in `public` and is not an RPC: it
-- returns `trigger`, a pseudo-type PostgREST cannot construct an argument for
-- and does not expose. Same posture as the sanitize triggers in 20260808000001.

-- ============================================================================
-- ADVERSARIAL PASS -- static review, no database was executed against.
--
-- 1. CAN A NON-FRIEND READ ANY LOG DATA? NO.
--    Both friend surfaces call private.friendship_visible() on their first
--    working line, which requires status = 'accepted'. There is no other path:
--    place_logs gains no policy, no grant, no view and no other function in this
--    file. The pre-existing readers of place_logs are unchanged --
--    place_rating_stats (k-anonymised at >= 3 raters, no user_id emitted) and
--    my_rank() (caller's own percentile). private.user_visited_rank() is the one
--    new reader and it lives in `private`, unreachable from PostgREST, called
--    only from behind the gate.
--
-- 2. CAN A PENDING (NOT ACCEPTED) REQUESTER READ ANYTHING? NO.
--    'pending' fails friendship_visible()'s `status = 'accepted'` test. What a
--    pending requester CAN learn is bounded and was already true before they
--    asked: that the handle they typed exists (find_user_by_handle), and its
--    display_name. Not home_region, not the count, not the percentile, not one
--    pin. Sending a request is not a read.
--
-- 3. CAN A REMOVED EX-FRIEND STILL READ? NO, IMMEDIATELY.
--    remove_friend() DELETEs the pair row, and the gate is an `exists` over that
--    row evaluated per call. There is no cached grant, no membership row, no
--    materialised copy, and no token. The next call returns 'not_found'.
--    Same for a deleted account: both FKs cascade from profiles, which cascades
--    from auth.users.
--
-- 4. CAN A BLOCKED EX-FRIEND STILL READ? NO, TWICE OVER.
--    Layer one: the user_blocks_ends_friendship trigger DELETEs the pair row on
--    every insert path into user_blocks -- the RPC, a direct POST (authenticated
--    has INSERT on that table), or the service key -- because it is a trigger and
--    not a check inside block_user(). Layer two: friendship_visible() calls
--    private.is_blocked_pair() independently, so even if the trigger were
--    dropped tomorrow the surface still closes. Blocking is symmetric, so it
--    does not matter which side blocked.
--
-- 5. CAN notes OR ratings LEAK THROUGH ANY PATH? NO. Enumerated:
--    * PostgREST table endpoint: place_logs still has exactly one policy,
--      owner-only. A friend's row is invisible, so no `select=` reaches it.
--    * Crafted `select=` on the RPC result: friend_places() returns an anonymous
--      record type of five named columns. There is no note or rating column in
--      the result set to name; `select=` can only narrow.
--    * PostgREST resource embedding: embedding traverses foreign keys between
--      real relations. An ad-hoc `returns table (...)` record type has no
--      relationship metadata, so `?select=*,place_logs(note,rating)` has nothing
--      to traverse.
--    * A view: none is created over place_logs by this file.
--    * The invite RPCs: neither reads place_logs at all; both return void.
--    * friend_profile(): returns two integers derived from a COUNT and a rank
--      over counts. No rating enters that computation -- note the filter is
--      `status = 'visited'` with no rating predicate, unlike place_rating_stats.
--    * private.user_visited_rank(): reads place_logs but projects only
--      count(*)::int per user_id, and is unreachable from the API.
--    RESIDUAL, ACCEPTED: an accepted friend learns the SET of places you have
--    played, which is a real disclosure of behaviour over time (poll
--    friend_places() daily and you learn what someone played yesterday). That is
--    the feature the owner asked for. It carries no note, no rating and no date.
--
-- 6. CAN SOMEONE ENUMERATE USERS, OR CONFIRM A HANDLE EXISTS? PARTIALLY, AND
--    THE RESIDUAL IS ACCEPTED AND STATED.
--    CLOSED: bulk enumeration. There is no prefix search, no fuzzy search, no
--    listing endpoint, and profiles is still "read own" so GET /profiles returns
--    one row. The only way to test a handle is one exact string at a time.
--    THROTTLED: 60 lookups + 10 requests per rolling hour per account, and
--    MISSES CONSUME THE CAP ON BOTH ENDPOINTS -- which is the whole point, since
--    on an enumeration endpoint the misses ARE the attack.
--      * find_user_by_handle(): a miss is an empty result set, the function
--        returns normally, the ledger row commits. 60/hour.
--      * request_friend(): a miss RETURNS the string 'not_found' rather than
--        raising it, so the transaction commits and the ledger row survives.
--        10/hour. This is a CORRECTION to an earlier draft of this file, which
--        raised 'not_found' here; a raise aborts the PostgREST transaction and
--        rolls the attempt row back, so every failed probe was free and only
--        successes were metered. That made this claim false for exactly the
--        calls that constitute the attack, and left an unthrottled enumeration
--        endpoint beside the throttled one. Both paths that mean "not_found"
--        (no such handle / the target blocked me) return identically, so
--        closing the hole did not open an oracle.
--    SO THE ACTUAL ENUMERATION BUDGET, per account, per rolling hour, is:
--    70 handle tests -- 60 through find_user_by_handle() and 10 through
--    request_friend() -- and not one more, hit or miss. The request_friend()
--    ten are additionally capped at 30 outstanding pending requests, so a
--    prober whose guesses land keeps stalling until they withdraw or are
--    answered; a prober whose guesses miss keeps the full 10 every hour. Both
--    caps are per-ACCOUNT and both reset by registering a new one: a fresh
--    account restores the full 70/hour, and the 30-pending cap, from zero.
--    Account creation is therefore the only real bound on total enumeration,
--    and it is Supabase auth's problem, not this file's (see item 7).
--    ACCEPTED, NOT CLOSED: a determined harasser CAN confirm that a specific
--    handle they already know is registered, at 70/hour per account, and can
--    create more accounts to multiply that. A dictionary attack against short
--    common handles is feasible over days across many accounts. Closing it
--    properly needs either device attestation or making handle-lookup return
--    nothing for users who have not opted into discoverability -- a profile
--    setting that does not exist yet, and the right fix if this ever becomes a
--    real complaint.
--    ALSO ACCEPTED: find_user_by_handle() returns display_name, so confirming a
--    handle also yields the name on the account. That is inherent to "let me
--    check I typed my friend's handle right".
--
-- 7. WHAT CAN A DETERMINED HARASSER STILL DO? Stated plainly, as asked.
--    * Send 10 friend requests an hour, one of which can be to the same person
--      once per 30 days after a decline. Each is a name in a list; there is no
--      free-text field anywhere in a friend request, so there is no message to
--      receive. That is the single most important limit here: this feature
--      cannot carry an insult -- WITH ONE QUALIFICATION added by the PROFILE
--      REPORTING section: the sender's own handle and display_name are free text
--      and they ride along with the request. The request carries no message; the
--      SENDER can be the message. That is why 'profile' is now a reportable
--      target type, and it is the mitigation for this specific hole.
--    * Hold up to 30 unanswered requests at once, then no more until some are
--      answered or withdrawn.
--    * Create new accounts to reset both caps. Account creation is the real
--      bound and it is not defended here -- it is Supabase auth's problem, and
--      it is the same residual 20260808000001 accepted for vote and endorsement
--      counts. The mitigations that exist are report_content() (capped at
--      20/hour, and as of this file it accepts 'profile' so the offensive handle
--      itself is reportable) and profiles.content_suspended_at, which
--      request_friend() honours, so a moderator suspension DOES stop the
--      friend-request channel -- but NOT the handle already on screen; see
--      "moderation runbook: WHAT TO DO ABOUT A PROFILE".
--    * Learn whether a handle they already know exists (item 6).
--    * NOT: send text. NOT: see whether a request was read, declined, or
--      ignored -- the silent cooldown makes those indistinguishable. NOT: see
--      anything about a target who has not accepted. NOT: repeat-request after
--      a decline for 30 days. NOT: continue after being blocked, in either
--      direction.
--
-- 8. CAN A MEMBER ESCALATE VIA THE INVITE RPCs? NO.
--    Both open with an ownership test against trip_plans.user_id /
--    visit_times.user_id = auth.uid(). A trip MEMBER is not an owner and gets
--    'not_owner', so the "invitee invites their own friends" ladder does not
--    exist. Note what is NOT closed and predates this file: a trip member can
--    already SELECT invite_code off the trip_plans row ("trip_plans: read as
--    member") and hand the code to anyone. That is 20260728000002's design, the
--    reason 20260828000001 refused to add a member SELECT policy to visit_times,
--    and it is unchanged here -- these RPCs add no new way to spread membership.
--    Also NO: the invite RPCs cannot be steered at a non-friend. `friend` is
--    checked by friendship_visible(), which the caller cannot influence.
--
-- 9. CAN FRIENDSHIP ROWS BE FORGED BY DIRECT PostgREST INSERT? NO. VERIFIED
--    STATICALLY, TWO INDEPENDENT LAYERS:
--    (a) PRIVILEGE: `revoke all on public.friendships from anon, authenticated`
--        followed by an explicit `revoke insert, update, delete`. Supabase's
--        default grant to those roles is removed, so PostgREST's own connection
--        role has no INSERT to exercise.
--    (b) POLICY: `alter table ... enable row level security` with ZERO policies
--        created. RLS with no policies denies every non-owner operation
--        outright, so even if a grant were restored the insert still fails.
--    The DEFINER RPCs are unaffected by either -- they execute as the function
--    owner (postgres), which is also the table owner and bypasses RLS.
--    And the SHAPE of a forged row is closed a third time by the schema itself:
--    friendships_ordered forbids the reversed duplicate and the self-row, and
--    friendships_requester_in_pair forbids `requested_by` naming a third party.
--    Same posture for friend_declines (a forged row there is a silent 30-day
--    muzzle on someone) and friend_request_attempts (a forged row there is a
--    denial-of-service against a specific user's own cap).
--
-- 10. DOES ANYTHING HERE LEAK LOCATION, TRAVEL TIME, OR REAL IDENTITY?
--    TRAVEL TIME: NO. visit_time_members is not read by any function in this
--      file. invite_friend_to_visit() INSERTs (visit_id, user_id) and leaves
--      travel_minutes null. 20260828000001's "read own" policy has no
--      owner-reads-all clause and this file does not add one, so the invitee's
--      travel time -- a proxy for where they live -- stays invisible to the
--      inviter, and vice versa.
--    LOCATION: YES, BY DESIGN AND BY OWNER DECISION, in two forms.
--      (i) home_region, a coarse free-text region the user typed on their own
--          profile, on the allowed list.
--      (ii) the set of places a friend has VISITED -- a historical map, with no
--          dates attached (visited_on is not projected) and no future intent
--          ('want' rows are excluded). It says where someone has been, never
--          where they are or will be.
--      NOT DISCLOSED: any coordinate of the person (places.location is the
--      COURSE's coordinate from a public catalog, and is not even projected
--      here), any tee time, any trip.
--      THE ONE FORWARD-LOOKING DISCLOSURE is invite_friend_to_visit(): the
--      invitee learns the inviter intends to be at a named place at a named
--      time. It is per-invitation, owner-initiated, and identical to what
--      handing over the invite code already did.
--    REAL IDENTITY: display_name is free text the user chose and may well be
--      their real name; it is on the owner's allowed list, and it is already
--      visible to any non-friend who knows the handle (find_user_by_handle).
--      No email, no auth.users column, no uuid-to-person mapping beyond what a
--      friend is shown, is exposed anywhere in this file.
--
-- 11. TIMING AND SIDE-CHANNELS. ACCEPTED, NOT CLOSED.
--    request_friend() raises 'blocked' before it raises 'too_many_requests' in
--    no case -- the throttle runs first -- but a caller who is under the cap can
--    still distinguish 'not_found' (no such handle OR they blocked me) from
--    'blocked' (I blocked them) from 'already_friends'. That set is deliberate
--    and each was argued above. Note that 'not_found' is now RETURNED while the
--    other two are RAISED (see item 6), so the three are distinguishable by HTTP
--    status as well as by string -- which changes nothing, because they were
--    already distinguishable by string and were meant to be. What matters is
--    that the two CAUSES of 'not_found' stay indistinguishable from each other,
--    and they do: same return, same literal, same single committed ledger row.
--    Response TIMING is not equalised anywhere in
--    this file (a cooldown no-op does less work than a real insert), which is a
--    real if impractical channel; equalising it would mean fake work on the fast
--    path and is not worth the complexity at this scale.
--
-- 12. UNBOUNDED GROWTH. BOUNDED, with one note.
--    friendships is bounded by real relationships and cascades away with either
--      account; the PK makes duplicate rows impossible.
--    friend_request_attempts self-prunes on every call (both RPCs delete this
--      user's out-of-window rows on the way in), so live size is bounded by
--      (accounts active in the last hour x <= 70 rows). Same residual as
--      report_attempts: a user who calls once and never returns leaves rows
--      behind. Negligible at launch scale; a sweep is over-engineering.
--    friend_declines is the note: it is pruned only opportunistically, on the
--      request_friend() path that actually reads a given pair's row. A pair
--      where the requester never asks again keeps one 3-column row forever. It
--      is bounded by the number of declined pairs ever created, which is
--      bounded by the request throttle (10/hour/account), so it cannot be
--      inflated faster than the harassment cap allows. ACCEPTED.
--
-- 13. SERVICE-KEY BEHAVIOUR. The user_blocks_ends_friendship trigger fires for
--    the service role too (it reads NEW, not auth.uid()), so an admin-inserted
--    block still terminates the friendship -- unlike visit_times_immutable,
--    which 20260828000001 noted blocks service-key repairs. Nothing in this file
--    compares auth.uid() inside a trigger, so there is no admin-repair trap to
--    rediscover during an incident.
--
-- 14. ACCEPTED, NOT CLOSED -- the rest.
--    * NO FRIEND LIMIT. Nothing caps how many ACCEPTED friends an account may
--      have, only how many pending requests it may hold. A popular account with
--      thousands of friends makes my_friends() a large response. Add a LIMIT/
--      OFFSET pair to the signature if that ever bites; PostgREST can already
--      paginate an RPC result with Range headers.
--    * NO MUTUAL-FRIEND SURFACE, and none should be added casually: "friends in
--      common" is a classic way to leak a graph edge between two people who have
--      only consented to their own edges.
--    * NO NOTIFICATION DELIVERY. This file creates rows; nothing here sends a
--      push. Whatever delivers "X sent you a request" must read
--      my_friend_requests() as the user, not query friendships with a service
--      key and fan out -- the latter would bypass the block filter.
--    * THE DECLINE COOLDOWN LIES TO THE SENDER, saying 'pending' for a request
--      that was not created. Argued at the call site. The cost is a UI that can
--      show "Requested" for something that will never arrive; the benefit is
--      that decline is not a read receipt. If this is ever reversed, the
--      outbound-list note under my_friend_requests must be revisited with it.
--    * remove_friend() ARMS A 30-DAY COOLDOWN AGAINST THE OTHER PARTY when an
--      accepted friendship ends. If two friends drift apart and one removes the
--      other by accident, the other cannot re-add them for a month -- and, per
--      the silence rule, is not told why. That is the deliberate trade: the
--      loop this closes (unfriend -> instant re-request) is a harassment
--      pattern, and the false positive is a month of waiting. The remover can
--      always re-add THEM, since the decline row is directional.
--      NOTE that the SILENCE is weaker for removal than for decline, and this
--      is unavoidable rather than overlooked: the removed party sees the person
--      disappear from their OWN my_friends() list, which is their own data and
--      cannot be withheld. So removal is observable and only the re-request
--      cooldown is silent, whereas a decline is invisible end to end.
--      AND THE GRIEF CASE: accept a request, then immediately remove, and the
--      other party is muzzled for 30 days without being told why. Accepted --
--      it costs the griefer an acceptance, it is strictly weaker than
--      block_user() which they could reach in one tap instead, and closing it
--      would mean not arming the cooldown on removal at all, which reopens the
--      unfriend/re-request loop this exists to stop.
--
-- 15. DOES report_content('profile', ...) BECOME A USER-ENUMERATION ORACLE?
--    NO NEW ONE, and the reasoning is worth writing down because the answer is
--    "no" for a specific reason and not because nothing is disclosed.
--    WHAT IT DISCLOSES. A report against a uuid with no profiles row raises
--    'not_found'; against a real account it returns void. Those two ARE
--    distinguishable, so the RPC does answer "is this uuid an account?".
--    WHY THAT IS NOT ENUMERATION. The probe takes a uuid, not a name. profiles.id
--    is gen_random_uuid()/auth.users.id -- 122 random bits. There is no ordering,
--    no sequence, no prefix and no listing to walk, so an attacker cannot
--    GENERATE candidate ids; guessing one is ~2^122 work. The only ways to hold
--    a user's uuid are find_user_by_handle() (which already told you the account
--    exists, and gave you the display_name too), my_friends(), my_friend_requests(),
--    and friend_profile() -- every one of which confirms existence more cheaply
--    and more informatively than this probe does. The oracle answers a question
--    you can only ask once you already know the answer. Enumeration is bounded
--    by the HANDLE surface (item 6), which this does not touch.
--    DOES THE EXISTENCE CHECK LEAK ANYTHING THE SCHEMA DOES NOT ALREADY? NO. It
--    projects nothing: `select exists (select 1 from public.profiles where id =
--    v_target)` returns one boolean into a local variable and the caller sees
--    only void-or-'not_found'. No handle, no display_name, no home_region, no
--    created_at, no suspension state. It is strictly less than
--    find_user_by_handle() already returns to any signed-in caller.
--    THE ONE ASYMMETRY, STATED. Per 20260808000003's own note, a raised
--    exception aborts the PostgREST transaction and rolls back the report_attempts
--    row, so a 'not_found' probe does NOT consume the 20/hour cap -- the probe is
--    effectively unthrottled at this layer. That is INHERITED, not introduced:
--    it is exactly as true today for 'trip' and 'condition_report' uuids. It is
--    tolerable for the same reason as above (the id space is unguessable), and
--    the polarity is deliberate -- rejected reports must not burn a real user's
--    ability to report. Note this is the OPPOSITE polarity to
--    find_user_by_handle(), where misses DO consume the cap; that is correct in
--    both places, because there the miss is the attack and here it is not. If a
--    uuid-probe channel ever matters, the fix is a throttle that survives
--    rollback (a separate connection or a deferred ledger), not a change here.
--    'own_profile' ADDS NO CHANNEL: it fires only on the caller's own id, which
--    the caller already knows.
--    NOT AN ORACLE ABOUT BLOCKING EITHER: report_content() does not consult
--    private.is_blocked_pair() at all (deliberately -- see that section), so it
--    cannot be used to test whether someone has blocked you. Its answer is the
--    same either way, which is the desired indistinguishability.
-- ============================================================================

commit;
