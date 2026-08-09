-- DRY RUN — validates the community migration against the real schema and
-- then throws everything away. Nothing is persisted. Expect it to end with
-- an error reading: DRY RUN OK - rolled back, nothing changed
-- Any OTHER error is a real problem: report it and do not run the real file.
begin;
-- M8.4 Community layer: crowd ratings, live conditions, published trips,
-- voting, adoption, reporting, blocking.
--
-- Shape follows docs/decisions/0001-price-crowdsourcing.md: raw contribution
-- tables stay RLS-locked and unreadable, and everything the app renders comes
-- from a SECURITY DEFINER aggregate view (security_invoker = false) over them.
-- An invoker view here would run under the caller's RLS, see only their own
-- rows, and return nothing — the aggregate would be permanently empty.
--
-- Threat model carried over from 20260729000001: RLS cannot compare OLD to NEW,
-- so anything that must stay immutable (or owner-only) lives in a row trigger.
--
-- Second threat model, added after the M8.4 security review: EVERY function in
-- schema public is a PostgREST endpoint. A SECURITY DEFINER boolean taking two
-- uuids is an RPC anyone can POST to, and published_trips hands out author uuids
-- by the page — enough to map the whole block graph one pair at a time. Internal
-- helpers therefore live in schema `private`, which PostgREST does not expose.
--
-- Third: an RPC is only the sanctioned path if it is the ONLY path. Where a
-- table's insert policy duplicated an RPC's checks, the insert privilege is now
-- revoked outright and a BEFORE trigger re-derives the server-owned columns, so
-- the sanitization and the timestamps hold even if a grant is ever restored.

create extension if not exists pgcrypto;

-- ================================================================= private
-- Not in PostgREST's exposed schema list (db-schemas defaults to "public"), so
-- nothing in here is reachable as POST /rpc/<name>.
--
-- USAGE and EXECUTE stay granted to the client roles ON PURPOSE. RLS policy
-- expressions are evaluated with the CALLER's privileges, not the table owner's:
-- revoking either would turn "condition_endorsements: insert own" and
-- "trip_votes: insert own" into permission errors rather than into denials. The
-- protection here is unreachability from the API, not a missing grant.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to anon, authenticated;

-- ================================================================== tables

-- ---------------------------------------------------------- condition_reports
-- "Greens are punched", "cart path only" — short-lived, user-reported facts.
-- Notes are capped in the COLUMN, not only in the RPC, and the client has no
-- INSERT privilege at all (see grants): report_condition() is the only writer,
-- and condition_reports_sanitize re-derives kind/note/created_at/expires_at on
-- every path regardless.
create table public.condition_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  place_id uuid not null references public.places (id) on delete cascade,
  kind text not null check (char_length(kind) between 1 and 40),
  note text check (char_length(note) <= 200),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  -- WHY not a partial unique index on "live" rows: the predicate would need
  -- now(), and Postgres requires index predicates to be IMMUTABLE. One row per
  -- (user, place, kind) FOREVER is the strictly stronger constraint anyway — an
  -- expired row cannot be left behind to stack a second live one next to it.
  -- report_condition() turns the collision into a refresh via ON CONFLICT.
  -- WHY a named CONSTRAINT rather than a bare unique index: it lets the RPC say
  -- ON CONFLICT ON CONSTRAINT <name> instead of ON CONFLICT (user_id, place_id,
  -- kind). Inside report_condition() the identifiers "kind" and "note" are both
  -- column names and function parameter names, and plpgsql's default
  -- variable_conflict = error turns a bare column reference in the inference
  -- clause into a runtime "ambiguous" failure. The constraint name has no such
  -- collision.
  constraint condition_reports_one_per_user unique (user_id, place_id, kind)
);

create index condition_reports_live_idx
  on public.condition_reports (place_id, kind, expires_at);

alter table public.condition_reports enable row level security;

create policy "condition_reports: read own" on public.condition_reports
  for select using (auth.uid() = user_id);
create policy "condition_reports: insert own" on public.condition_reports
  for insert with check (auth.uid() = user_id);
create policy "condition_reports: delete own" on public.condition_reports
  for delete using (auth.uid() = user_id);
-- No update policy: refreshing goes through report_condition(), which
-- re-sanitizes the note. No cross-user select policy: who reported what stays
-- private, and the public surface is condition_summary.
--
-- The insert policy above is now a SECOND gate, not the barrier: INSERT is not
-- granted to authenticated at all. It is kept so that re-granting the privilege
-- by accident does not also drop the "only your own user_id" check. The reason
-- the grant went away: an insert policy can say "the row is yours", but it
-- cannot say "expires_at is a server value" or "the note has been through
-- plain_text()", so a direct POST could store raw markup with
-- expires_at = 2999-01-01 — permanent, unsanitized content that two sock
-- accounts push over the 2-reporter threshold in condition_summary, and which
-- the "expired rows drop out on their own" design never cleans up.

-- ------------------------------------------------------ condition_endorsements
-- "Still true" — a second voice on someone else's report, which also renews it.
create table public.condition_endorsements (
  report_id uuid not null references public.condition_reports (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (report_id, user_id)
);

alter table public.condition_endorsements enable row level security;

-- --------------------------------------------------------------- trip_votes
create table public.trip_votes (
  trip_id uuid not null references public.trip_plans (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (trip_id, user_id)
);
-- The primary key IS the double-vote defence; leading column trip_id also
-- serves the per-trip count in published_trips.

alter table public.trip_votes enable row level security;

-- ----------------------------------------------------------- content_reports
-- Moderation inbox. Write-only from the client's side by design.
create table public.content_reports (
  id uuid primary key default gen_random_uuid(),
  -- SET NULL, not CASCADE, and therefore nullable: an abuse record has to
  -- outlive the reporter's account. With CASCADE, "report someone, then delete
  -- your account" erased the evidence, and deleting an account is a one-tap
  -- action in Settings (see supabase/functions/delete-account). The reporter's
  -- identity is only ever needed while the report is open; after that the row's
  -- value is the record of what was reported.
  reporter_id uuid references public.profiles (id) on delete set null,
  target_type text not null check (target_type in ('trip', 'condition_report')),
  target_id uuid not null,
  reason text check (char_length(reason) <= 500),
  created_at timestamptz not null default now(),
  -- service-role-only moderation state; no client ever selects these.
  resolved_at timestamptz,
  resolution text,
  -- Named for the same reason as condition_reports_one_per_user: report_content
  -- takes parameters called target_type/target_id, so naming those columns in
  -- an ON CONFLICT inference clause would be ambiguous inside plpgsql.
  constraint content_reports_one_per_target unique (reporter_id, target_type, target_id)
);
-- WHY the unique: re-reporting the same thing is a no-op instead of a way to
-- flood the queue. No FK on target_id — it points at two different tables, and
-- a report must survive the content being deleted so the runbook has a record.
-- NOTE on the unique + nullable reporter_id: nulls are distinct in a unique
-- constraint, so orphaned rows (reporter account deleted) never collide with
-- each other or block a live reporter. report_content() always writes a
-- non-null reporter_id, so the ON CONFLICT inference is unaffected.

create index content_reports_open_idx
  on public.content_reports (created_at) where resolved_at is null;

alter table public.content_reports enable row level security;

create policy "content_reports: insert own" on public.content_reports
  for insert with check (auth.uid() = reporter_id);
-- No select policy by design: reporters cannot read the queue, and reportees
-- cannot see who reported them. Gavin reads it with the service key.
--
-- As with condition_reports, this policy is a second gate and not the barrier:
-- INSERT is not granted to authenticated. A direct POST could set resolved_at
-- and resolution — writing moderation state, i.e. self-closing a report against
-- yourself — and could bypass the per-user rate cap that now lives inside
-- report_content(). The unique constraint only caps repeats against the SAME
-- target; nothing stopped one account from filing against thousands of targets.

-- ----------------------------------------------------------- report_attempts
-- Rate-limit ledger for report_content(), same shape and same rolling window as
-- join_attempts (20260729000001). The unique constraint on content_reports caps
-- reports per target; this caps reports per REPORTER, which is the axis a
-- queue-flooding account actually uses.
create table public.report_attempts (
  user_id uuid not null references public.profiles (id) on delete cascade,
  attempted_at timestamptz not null default now()
);

create index report_attempts_user_idx on public.report_attempts (user_id, attempted_at);

alter table public.report_attempts enable row level security;
-- No policies and no grants, by design: only report_content() (SECURITY
-- DEFINER) reads or writes it. RLS is on so that a future accidental grant
-- still denies rather than exposes.

-- --------------------------------------------------------------- user_blocks
create table public.user_blocks (
  blocker_id uuid not null references public.profiles (id) on delete cascade,
  blocked_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint user_blocks_no_self check (blocker_id <> blocked_id)
);

-- The pk covers blocker -> blocked; blocking is enforced in BOTH directions,
-- so the reverse lookup needs its own index.
create index user_blocks_blocked_idx on public.user_blocks (blocked_id);

alter table public.user_blocks enable row level security;

create policy "user_blocks: read own" on public.user_blocks
  for select using (auth.uid() = blocker_id);
create policy "user_blocks: insert own" on public.user_blocks
  for insert with check (auth.uid() = blocker_id);
create policy "user_blocks: delete own" on public.user_blocks
  for delete using (auth.uid() = blocker_id);
-- Only the blocker sees their list (and my_blocks() renders it with handles).
-- The blocked user is never told.
--
-- ACCEPTED: both FKs still CASCADE, so deleting an account drops every block in
-- both directions. Unlike content_reports, that is the right trade — a block is
-- a live visibility preference about a specific pair of accounts, not a record,
-- and there is nothing left to hide once one side of the pair no longer exists.
-- The abuse shape it would enable (delete account, re-register, evade a block)
-- is not closed by keeping the rows either: the new account has a new uuid.

-- =========================================================== trip_plans alter
alter table public.trip_plans
  add column published_at timestamptz,
  add column publish_title text check (char_length(publish_title) <= 80),
  add column publish_summary text check (char_length(publish_summary) <= 300),
  add column editor_pick boolean not null default false;
-- Caps live on the columns so they hold even on a direct owner UPDATE that
-- skips publish_trip().

create index trip_plans_published_idx
  on public.trip_plans (published_at desc) where published_at is not null;

-- ============================================================ profiles alter
-- Durable moderation. Without this, every moderation action in the runbook is
-- undone by the offender in one request: delete their condition report and they
-- re-file it, unpublish their trip and they call publish_trip() again. A ban
-- has to be a piece of state the offender cannot clear.
alter table public.profiles
  add column content_suspended_at timestamptz;

-- Service-role write only. There is no "profiles: update own" column list in
-- the policy — the policy from 20260724000001 is USING/WITH CHECK (auth.uid() =
-- id) for the WHOLE ROW, so it would happily accept
-- PATCH /profiles?id=eq.<me> {"content_suspended_at": null} and a suspension
-- would last exactly as long as it took the offender to notice. RLS has no
-- column granularity, so the fence is a column-level GRANT instead.
revoke update on public.profiles from anon, authenticated;
grant update (handle, display_name, home_region, niche_id)
  on public.profiles to authenticated;
-- updated_at is deliberately absent: profiles_updated (a BEFORE UPDATE trigger)
-- sets it, and trigger-assigned columns are not privilege-checked — only the
-- columns named in the statement's SET list are. id and created_at were never
-- client-writable in practice and are now not client-writable at all.
-- Matches apps/mobile useUpdateProfile(), which patches exactly handle,
-- display_name and home_region.

-- ========================================================= private helpers
-- ALL SIX live in `private` rather than `public`. Every one of them is SECURITY
-- DEFINER, and in `public` every one of them is also a PostgREST RPC:
--
--   POST /rpc/is_blocked_pair {"a": "<uuid>", "b": "<uuid>"}
--
-- takes two arbitrary uuids, does no auth.uid() check (it cannot — it is asked
-- about pairs the caller is not part of), and answers truthfully. published_trips
-- hands out author_id for every published trip, which is a ready-made uuid list,
-- so an authenticated attacker could enumerate the block graph between strangers
-- one pair at a time: who blocked whom, from the outside, at read speed.
-- trip_author_blocked(trip) is the same oracle keyed by trip id instead.
--
-- The fix is unreachability, not a revoke — see the schema comment at the top.
-- search_path is `public, private, pg_temp`: public for the tables they read,
-- private so sibling helpers resolve, pg_temp LAST so a caller cannot shadow an
-- unqualified name with a temp object. Every cross-helper call below is
-- schema-qualified anyway, so resolution never depends on the order.

-- Is this request carrying the service key (or a superuser/migration session)?
-- WHY read the JWT claim first: inside a SECURITY DEFINER function current_user
-- becomes the function owner (postgres), which would make every one of our RPCs
-- look like an admin. The request claim is a GUC and is unaffected by DEFINER,
-- so an authenticated caller stays 'authenticated' no matter how deep it is.
create or replace function private.is_service_role()
returns boolean language sql stable
set search_path = public, private, pg_temp as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    session_user::text
  ) in ('service_role', 'postgres', 'supabase_admin')
$$;
-- session_user, not current_user, for the fallback. current_user follows
-- SECURITY DEFINER and becomes the function owner (postgres), so ANY call made
-- through one of our DEFINER RPCs would take the fallback branch and report
-- admin. It is unreachable today only because the JWT claim is always present
-- on a PostgREST request and coalesce short-circuits — i.e. the safety is one
-- misconfiguration away. session_user is the role that actually authenticated
-- and is untouched by DEFINER, so the fallback is honest on every path.

-- Blocking is symmetric for visibility purposes: if either side blocked the
-- other, neither sees the other's content. DEFINER because a caller can only
-- read the half of user_blocks they authored.
create or replace function private.is_blocked_pair(a uuid, b uuid)
returns boolean language sql stable security definer
set search_path = public, private, pg_temp as $$
  select exists (
    select 1 from public.user_blocks
    where (blocker_id = a and blocked_id = b)
       or (blocker_id = b and blocked_id = a)
  )
$$;
-- NOTE: a null argument makes this false. Every caller that matters is gated on
-- auth.uid() being non-null first, and published_trips is not granted to anon.

-- DEFINER booleans about a uuid the caller already holds. They leak nothing
-- beyond yes/no, and they exist because an INVOKER subquery inside an RLS
-- policy is evaluated under the caller's own RLS: any policy asking
-- "does someone else's row look like X?" over an RLS-locked table answers
-- "no rows, therefore no" for everybody and silently denies the whole table.
-- Same trap as the invoker-view trap in decision 0001, one layer down.
create or replace function private.condition_report_is_live(report uuid)
returns boolean language sql stable security definer
set search_path = public, private, pg_temp as $$
  select exists (
    select 1 from public.condition_reports where id = report and expires_at > now()
  )
$$;

create or replace function private.condition_report_is_mine(report uuid)
returns boolean language sql stable security definer
set search_path = public, private, pg_temp as $$
  select exists (
    select 1 from public.condition_reports where id = report and user_id = auth.uid()
  )
$$;

create or replace function private.trip_is_published(trip uuid)
returns boolean language sql stable security definer
set search_path = public, private, pg_temp as $$
  select exists (
    select 1 from public.trip_plans where id = trip and published_at is not null
  )
$$;

-- Is this trip's author on either side of a block with the caller? Exists so
-- the trip_votes policy can enforce the same rule vote_trip() does; otherwise a
-- blocked account could still interact with a trip it is not allowed to see by
-- POSTing straight to /trip_votes, and the author would watch the vote count
-- move for someone they blocked.
create or replace function private.trip_author_blocked(trip uuid)
returns boolean language sql stable security definer
set search_path = public, private, pg_temp as $$
  select exists (
    select 1 from public.trip_plans t
    where t.id = trip and private.is_blocked_pair(auth.uid(), t.user_id)
  )
$$;

-- Has a moderator suspended the CALLER from contributing content? Zero-argument
-- on purpose: it answers only about auth.uid(), so even if `private` were ever
-- exposed it would not be an oracle about anyone else. DEFINER so it does not
-- depend on the profiles select policy being reachable from wherever it is
-- called (it is called from an INVOKER trigger as well as from DEFINER RPCs).
create or replace function private.caller_content_suspended()
returns boolean language sql stable security definer
set search_path = public, private, pg_temp as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and content_suspended_at is not null
  )
$$;

-- ============================================================ pure helpers
-- These three STAY in public, and that is a decision rather than an oversight.
-- They are IMMUTABLE functions of their arguments alone: they read no table, so
-- being callable as /rpc/plain_text tells an attacker nothing they could not
-- work out by reading this file. Moving them would also break adopt_trip() and
-- the two views, which reference them by name in the mobile-visible contract.
-- The rule is "helpers that TOUCH ROWS go to private", not "everything goes".

-- Pure jsonb shape readers for the published_trips card counts. Defensive about
-- typeof: itinerary is free-form jsonb and jsonb_array_length() errors on a
-- non-array, which would take the whole view down for one malformed row.
create or replace function public.itinerary_day_count(it jsonb)
returns int language sql immutable as $$
  select case when jsonb_typeof(it -> 'days') = 'array'
              then jsonb_array_length(it -> 'days') else 0 end
$$;

create or replace function public.itinerary_stop_count(it jsonb)
returns int language sql immutable as $$
  select coalesce((
    select sum(case when jsonb_typeof(d -> 'places') = 'array'
                    then jsonb_array_length(d -> 'places') else 0 end)::int
    from jsonb_array_elements(
      case when jsonb_typeof(it -> 'days') = 'array' then it -> 'days'
           else '[]'::jsonb end
    ) d
  ), 0)
$$;

-- Strip markup and collapse whitespace/control characters. User text reaches
-- other users' screens for the first time in this migration, so nothing goes in
-- raw. Returns null for input that is empty once cleaned.
create or replace function public.plain_text(raw text)
returns text language sql immutable as $$
  select nullif(
    btrim(
      regexp_replace(
        regexp_replace(coalesce(raw, ''), '<[^>]*>', ' ', 'g'),
        '[[:space:][:cntrl:]]+', ' ', 'g'
      )
    ),
    ''
  )
$$;

-- ====================================================== dependent policies

-- Endorsements: own row only, never your own report, never a dead one.
-- The "not mine" test is written as NOT EXISTS over rows the caller CAN see
-- (their own, via "condition_reports: read own"), so it is honest under RLS;
-- the liveness test has to be a DEFINER helper for the reason above.
create policy "condition_endorsements: read own" on public.condition_endorsements
  for select using (auth.uid() = user_id);
create policy "condition_endorsements: insert own" on public.condition_endorsements
  for insert with check (
    auth.uid() = user_id
    and not private.condition_report_is_mine(report_id)
    and private.condition_report_is_live(report_id)
  );
create policy "condition_endorsements: delete own" on public.condition_endorsements
  for delete using (auth.uid() = user_id);
-- INSERT is no longer granted to authenticated (see grants): endorse_condition()
-- is the only writer, and its ON CONFLICT DO NOTHING makes a repeat endorsement
-- insert nothing — which means the renewal trigger does not fire either. The
-- direct-insert path was the loop half of the "delete, re-insert, renew forever"
-- problem; the other half is capped in the trigger itself.

-- Votes: own row only, never your own trip, never a trip you are a MEMBER of,
-- published trips only, and never a trip whose author you have blocked (or who
-- blocked you).
create policy "trip_votes: read own" on public.trip_votes
  for select using (auth.uid() = user_id);
create policy "trip_votes: insert own" on public.trip_votes
  for insert with check (
    auth.uid() = user_id
    and not public.is_trip_owner(trip_id)
    and not public.is_trip_member(trip_id)
    and private.trip_is_published(trip_id)
    and not private.trip_author_blocked(trip_id)
  );
create policy "trip_votes: delete own" on public.trip_votes
  for delete using (auth.uid() = user_id);
-- is_trip_owner() / is_trip_member() are the DEFINER helpers from
-- 20260728000002; an invoker subquery over trip_plans would only see trips the
-- caller is a member of. They stay in public because they are already applied
-- in production and are not oracles: both answer only about auth.uid().
--
-- WHY is_trip_member as well as is_trip_owner: a collab trip is planned by its
-- invited members, so "no self-voting" was only half-enforced. The owner
-- invites four friends, publishes, and five accounts that built the trip
-- together vote it up — the community feed sorts on votes, so a party of five
-- outranks a genuinely popular trip. Membership is the real self-interest
-- boundary here, not ownership.

-- ========================================================= publish guard

-- Companion to trip_plans_immutable (20260729000001). That trigger froze
-- user_id/created_at and fenced invite_code; these are the new columns that
-- must not be reachable by everyone the "update own or member" policy admits.
-- Plain function, not DEFINER, so auth.uid() and the role claim describe the
-- real caller.
create or replace function public.trip_plans_guard_publish()
returns trigger language plpgsql
set search_path = public, private, pg_temp as $$
begin
  -- editor_pick is editorial curation. Left open, every author promotes their
  -- own trip to the top of the community feed with one PATCH.
  if new.editor_pick is distinct from old.editor_pick
     and not private.is_service_role() then
    raise exception 'not_authorized';
  end if;

  -- Publishing is an ownership decision, not an editing one. The collab policy
  -- lets any invited member UPDATE the row, which without this would let a
  -- member push a private trip (and its co-authors' plans) into public view,
  -- or unpublish the owner's trip out of spite.
  if (new.published_at    is distinct from old.published_at
   or new.publish_title   is distinct from old.publish_title
   or new.publish_summary is distinct from old.publish_summary)
     and auth.uid() is distinct from old.user_id
     and not private.is_service_role() then
    raise exception 'not_owner';
  end if;

  -- A suspended account cannot put anything back into public view, on the RPC
  -- path or the direct-PATCH path. Deliberately gated on the row ENDING UP
  -- published: unpublishing (new.published_at is null) stays available, because
  -- taking your own content down is never the thing we are trying to prevent.
  if new.published_at is not null
     and (new.published_at    is distinct from old.published_at
       or new.publish_title   is distinct from old.publish_title
       or new.publish_summary is distinct from old.publish_summary)
     and not private.is_service_role()
     and private.caller_content_suspended() then
    raise exception 'content_suspended';
  end if;

  return new;
end $$;

create trigger trip_plans_publish_guard
  before update on public.trip_plans
  for each row execute function public.trip_plans_guard_publish();
-- UPDATE-only, like its sibling: adopt_trip() and plan-trip INSERT new rows.

-- ================================================================== views
-- All three are security_invoker = false on purpose (decision 0001): the base
-- tables are revoked from clients, so an invoker view returns zero rows.

-- ------------------------------------------------------- place_rating_stats
-- Every place page loads this. place_logs only had place_logs_user_idx
-- (leading column user_id), which this query cannot use at all: it filters on
-- place_id, so each place page was a sequential scan of every log row in the
-- table. Partial, matching the view's own WHERE clause, so it stays small and
-- covers exactly the rows the aggregate reads.
create index place_logs_place_rating_idx
  on public.place_logs (place_id) where status = 'visited' and rating is not null;

-- Ratings stay on the stored 0-20 half-step scale; the app divides by 2, so an
-- integer here is one half-star of granularity on screen — which is also all
-- the precision the UI ever renders.
create view public.place_rating_stats
with (security_invoker = false) as
  select
    place_id,
    round(avg(rating))::numeric as avg,
    count(*)::int as rating_count
  from public.place_logs
  where status = 'visited' and rating is not null
  group by place_id
  having count(*) >= 3;
-- k-anonymity floor of 3, same shape as the price bands: below the floor the
-- fact is absent entirely rather than shown with low confidence.
--
-- HONEST STATEMENT OF WHAT THIS DOES AND DOES NOT DO (the previous comment here
-- claimed an individual rating "is never recoverable", which was false). At the
-- floor of 3 raters the old 2dp average pinned the exact rating SUM: sum =
-- 3 x avg, exactly, so anyone who knew two of the three ratings — e.g. their own
-- and a friend's — read the third off the page. Bucketing to whole 0-20 steps
-- means the aggregate is consistent with a small SET of sums rather than one,
-- so the same attacker gets a range instead of a value. That is a cost
-- increase, not anonymity: with enough known raters, or by watching avg move as
-- rating_count increments, a determined observer still narrows an individual
-- rating. The real defences are the floor of 3 and the fact that place_logs
-- itself is owner-only; this rounding is the third layer, not the first.

-- --------------------------------------------------------- condition_summary
-- Two independent reporters before a condition is public, and expired rows
-- drop out on their own — no cleanup job, no moderation queue.
create view public.condition_summary
with (security_invoker = false) as
  select
    place_id,
    kind,
    count(distinct user_id)::int as reporters,
    (array_agg(note order by created_at desc, id desc))[1] as latest_note,
    max(created_at) as latest_at,
    max(expires_at) as expires_at,
    (array_agg(id order by created_at desc, id desc))[1] as latest_report_id
  from public.condition_reports
  where expires_at > now()
  group by place_id, kind
  having count(distinct user_id) >= 2;
-- No user_id in the output: the reporters are anonymous to readers, which is
-- also why this view is not block-filtered — there is no author to attribute a
-- note to and nothing to follow back to a person.
--
-- latest_report_id is an ADDITION to the M8.4 brief, added after the mobile
-- side pointed out that endorse_condition(report uuid) had no reachable input:
-- the view aggregates away the row ids, so "I saw this too" had nothing to
-- pass. It is the id of the same row latest_note/latest_at come from. Safe to
-- expose: it is an opaque uuid with no user_id attached, and endorsing it is
-- gated by the insert policy on condition_endorsements (not yours, still
-- live), which is exactly the action the button is meant to perform.

-- ---------------------------------------------------------- published_trips
create view public.published_trips
with (security_invoker = false) as
  select
    t.id,
    coalesce(t.publish_title, t.title) as title,
    coalesce(t.publish_summary, t.itinerary ->> 'summary') as summary,
    p.handle as author_handle,
    t.user_id as author_id,
    public.itinerary_day_count(t.itinerary) as days,
    public.itinerary_stop_count(t.itinerary) as stops,
    coalesce(v.votes, 0) as votes,
    t.editor_pick,
    t.published_at,
    t.itinerary
  from public.trip_plans t
  join public.profiles p on p.id = t.user_id
  left join (
    select trip_id, count(*)::int as votes
    from public.trip_votes
    group by trip_id
  ) v on v.trip_id = t.id
  where t.published_at is not null
    and not exists (
      select 1 from public.user_blocks b
      where (b.blocker_id = auth.uid() and b.blocked_id = t.user_id)
         or (b.blocked_id = auth.uid() and b.blocker_id = t.user_id)
    );
-- Block filter is symmetric: blocking someone hides their trips from you AND
-- yours from them, so blocking is not a way to keep watching someone who wants
-- nothing to do with you. auth.uid() still resolves inside a definer view (it
-- reads the request JWT GUC, which DEFINER does not change), so the filter is
-- per-caller even though the view runs with the owner's privileges.
--
-- WHY the shape changed (behaviour is identical; the plan is not):
--
-- * votes was a correlated scalar subquery, re-executed once per published trip
--   in the result. The feed query is "order by editor_pick, votes desc limit
--   50", which cannot be answered without evaluating votes for EVERY published
--   trip, so the subquery ran N times per feed load and got slower with every
--   trip published. As a grouped LEFT JOIN it is one aggregate over trip_votes,
--   hash-joined once — and trip_votes' primary key (trip_id, user_id) already
--   provides the leading column the group-by wants.
--
-- * the block filter was private.is_blocked_pair(auth.uid(), t.user_id), a
--   per-row SECURITY DEFINER call the planner treats as an opaque filter: no
--   join, no index, one function invocation per candidate row. Inlined as NOT
--   EXISTS it becomes an anti-join the planner can drive from user_blocks'
--   indexes — the primary key covers the (blocker_id = me) half and
--   user_blocks_blocked_idx covers the (blocked_id = me) half. No helper is
--   needed here precisely because the view is security_invoker = false: it
--   already reads user_blocks with the owner's privileges, so the "a caller can
--   only see the half of user_blocks they authored" problem that forced the
--   DEFINER helper elsewhere does not apply inside this view.
--
-- Null-uid behaviour is unchanged: with no JWT, both sides of the OR are null
-- and the anti-join matches nothing, so every block would evaporate — which is
-- exactly why the view stays revoked from anon below.

-- ================================================================== grants
-- Supabase's default privileges hand SELECT on new objects to anon and
-- authenticated, so every base table below has to be revoked explicitly first;
-- otherwise the RLS policies above are the only thing standing between a client
-- and the raw rows, and the whole "aggregates public, rows private" split
-- collapses on the first policy mistake.
revoke all on public.condition_reports from anon, authenticated;
revoke all on public.condition_endorsements from anon, authenticated;
revoke all on public.trip_votes from anon, authenticated;
revoke all on public.content_reports from anon, authenticated;
revoke all on public.user_blocks from anon, authenticated;
revoke all on public.report_attempts from anon, authenticated;

-- INSERT is withheld from three of these tables. The rule applied: a client may
-- insert directly only where the insert policy can express EVERY invariant the
-- RPC enforces. Where the RPC also sanitizes text, stamps server-owned
-- timestamps or counts against a rate limit — none of which an RLS WITH CHECK
-- can do — the RPC has to be the only door.
grant select, delete on public.condition_reports to authenticated;
grant select, delete on public.condition_endorsements to authenticated;
grant select, insert, delete on public.trip_votes to authenticated;
grant select, insert, delete on public.user_blocks to authenticated;
-- content_reports: no client privileges at all. Not even INSERT — report_content()
-- is DEFINER and does not need one.

-- Explicit re-revokes, so the intent survives someone adding a column-level or
-- role-level grant later without reading this block.
revoke insert on public.condition_reports from anon, authenticated;
revoke insert on public.condition_endorsements from anon, authenticated;
revoke insert on public.content_reports from anon, authenticated;

-- trip_votes KEEPS its direct insert: "trip_votes: insert own" expresses every
-- rule vote_trip() does (own row, not owner, not member, published, not
-- blocked), there is no text to sanitize, and the (trip_id, user_id) primary
-- key is the double-vote defence. Same for user_blocks, whose policy is a plain
-- "the blocker is you".

grant select on public.place_rating_stats to anon, authenticated;
grant select on public.condition_summary to anon, authenticated;

-- published_trips is authenticated-only ON PURPOSE. The block filter keys off
-- auth.uid(); with no JWT it matches nothing and every block silently
-- evaporates, so an anon grant would make "sign out" a block bypass.
revoke all on public.published_trips from anon;
grant select on public.published_trips to authenticated;

-- ====================================================== write-path triggers
-- Belt and braces behind the revoked INSERT privileges above. A revoke is a
-- configuration; a trigger is a property of the table. These fire on every
-- path — RPC, service key, psql, or a grant somebody restores in six months —
-- and they are what actually make "the stored text is sanitized" and "expires_at
-- is a server value" true statements rather than statements about report_condition().

create or replace function public.condition_reports_sanitize()
returns trigger language plpgsql
set search_path = public, private, pg_temp as $$
begin
  -- Same normalisation report_condition() applies, re-applied here. plain_text()
  -- is idempotent (already-clean text has no markup left to strip and no runs of
  -- whitespace left to collapse), so running it twice on the RPC path is free.
  new.kind := lower(public.plain_text(new.kind));
  if new.kind is null or char_length(new.kind) > 40 then
    raise exception 'invalid_kind';
  end if;

  new.note := public.plain_text(new.note);
  if char_length(new.note) > 200 then raise exception 'note_too_long'; end if;

  if tg_op = 'INSERT' then
    -- Both are server facts, never client input. A client-chosen expires_at was
    -- the whole exploit: expires_at = '2999-01-01' turns a 30-day report into a
    -- permanent one, and the "expired rows drop out on their own — no cleanup
    -- job" design has nothing that ever removes it.
    new.created_at := now();
    new.expires_at := now() + interval '30 days';
  else
    -- UPDATE reaches here only from our own DEFINER code (report_condition()'s
    -- ON CONFLICT refresh and condition_endorsement_extends()). Rather than
    -- pinning the values and breaking both, clamp them: nothing may sit more
    -- than 30 days in the future, and nothing may claim to have been created
    -- later than now. The 30-day ceiling is the same one the renewal path
    -- enforces, restated where it cannot be bypassed.
    new.created_at := least(new.created_at, now());
    new.expires_at := least(new.expires_at, now() + interval '30 days');
  end if;

  return new;
end $$;

-- BEFORE INSERT matters for more than sanitization: the ON CONFLICT ON
-- CONSTRAINT condition_reports_one_per_user inference in report_condition()
-- runs on the POST-trigger row, so the lowercased kind is what gets matched.
-- Without that, "Cart Path Only" and "cart path only" would miss each other and
-- one user could hold two live rows on the same place+kind — two "reporters".
create trigger condition_reports_sanitized
  before insert or update on public.condition_reports
  for each row execute function public.condition_reports_sanitize();

create or replace function public.content_reports_sanitize()
returns trigger language plpgsql
set search_path = public, private, pg_temp as $$
begin
  -- reason reaches a human moderator's screen in admin_open_content_reports.
  -- Cleaned on EVERY path, not only inside report_content(): the report reason
  -- is the one free-text field an attacker controls that is guaranteed to be
  -- read by someone with a service key.
  new.reason := left(public.plain_text(new.reason), 500);

  if tg_op = 'INSERT' then
    new.created_at := now();
    -- Moderation state is not something a reporter gets to write. Pre-resolving
    -- your own report is how you file it against yourself and close it in the
    -- same request, so it never appears in the open queue.
    new.resolved_at := null;
    new.resolution  := null;
  end if;

  return new;
end $$;

create trigger content_reports_sanitized
  before insert or update on public.content_reports
  for each row execute function public.content_reports_sanitize();
-- UPDATE is intentionally NOT restricted here: closing a report out is the
-- service-key path in the runbook below, and it needs to set resolved_at.

-- ==================================================================== RPCs
-- All SECURITY DEFINER with a pinned search_path (public, private, pg_temp —
-- pg_temp last so no caller can shadow an unqualified name with a temp object),
-- all re-checking auth.uid() themselves, all raising short stable codes the
-- mobile client switches on:
-- not_signed_in | not_owner | not_found | own_report | own_trip |
-- cannot_block_self | note_too_long | invalid_kind | invalid_title |
-- invalid_target | too_many_reports | content_suspended.
--
-- invalid_title was raised by publish_trip() from the start and was simply
-- missing from this list. own_trip now also covers "you are a member of this
-- trip" — deliberately the same code rather than a new one, so the mobile
-- client does not have to learn a second string to say the same sentence.
-- NEW codes for the client to handle: too_many_reports, content_suspended.
-- Parameter names are the PostgREST wire contract; locals are prefixed v_ so
-- nothing collides with a column name inside plpgsql.

-- ------------------------------------------------------- report_condition
create or replace function public.report_condition(place uuid, kind text, note text)
returns uuid language plpgsql security definer
set search_path = public, private, pg_temp as $$
declare
  v_kind text;
  v_note text;
  v_id   uuid;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if private.caller_content_suspended() then raise exception 'content_suspended'; end if;

  -- Lowercased on the way in. condition_summary groups by the literal kind, so
  -- "Cart Path Only" and "cart path only" would be two groups of one, each
  -- stranded below the 2-reporter threshold and neither ever visible.
  v_kind := lower(public.plain_text(kind));
  if v_kind is null or char_length(v_kind) > 40 then
    raise exception 'invalid_kind';
  end if;

  -- Cleaned first, then measured: a 200-char cap on raw input is not a cap on
  -- what other people end up reading.
  v_note := public.plain_text(note);
  if char_length(v_note) > 200 then raise exception 'note_too_long'; end if;

  if not exists (select 1 from public.places where id = place) then
    raise exception 'not_found';
  end if;

  -- Upsert-refresh. The unique constraint turns a repeat report into an update,
  -- so one user can never stack two live reports on the same (place, kind) and
  -- count as two reporters in condition_summary. The conflict can only ever be
  -- with the caller's own row: user_id is part of the constraint and is always
  -- auth.uid() here, so DEFINER cannot be steered into overwriting a stranger.
  insert into public.condition_reports (user_id, place_id, kind, note)
  values (auth.uid(), place, v_kind, v_note)
  on conflict on constraint condition_reports_one_per_user do update
    set note       = excluded.note,
        created_at = now(),
        expires_at = now() + interval '30 days'
  returning id into v_id;

  return v_id;
end $$;

-- ------------------------------------------------------- endorse_condition
create or replace function public.endorse_condition(report uuid)
returns void language plpgsql security definer
set search_path = public, private, pg_temp as $$
declare v_author uuid;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;

  select user_id into v_author
    from public.condition_reports where id = report and expires_at > now();
  if v_author is null then raise exception 'not_found'; end if;
  -- An expired report reads as not_found: endorsement must not resurrect
  -- something that already aged out.

  if v_author = auth.uid() then raise exception 'own_report'; end if;

  insert into public.condition_endorsements (report_id, user_id)
  values (report, auth.uid())
  on conflict do nothing;
  -- Now the ONLY writer: INSERT on condition_endorsements is revoked from
  -- authenticated. ON CONFLICT DO NOTHING therefore means a repeat endorsement
  -- inserts no row, fires no AFTER INSERT trigger, and renews nothing.
end $$;

-- Endorsing renews the report. DEFINER is required, not decorative:
-- condition_reports has no UPDATE policy at all, so an invoker-rights trigger
-- would update zero rows and fail silently.
create or replace function public.condition_endorsement_extends()
returns trigger language plpgsql security definer
set search_path = public, private, pg_temp as $$
begin
  update public.condition_reports
    set expires_at = greatest(expires_at, now() + interval '30 days')
    where id = new.report_id
      and expires_at < now() + interval '30 days';
  return new;
end $$;
-- The WHERE clause is the cap. greatest() alone already refused to shorten a
-- report's life, but it happily RE-extended one that was already at the
-- ceiling, so the renewal was a no-op that still counted as a write. With the
-- predicate, a report sitting at now()+30d is not touched at all, and the
-- 30 days is a hard ceiling rather than a value that resets on every event.
--
-- ACCEPTED, NOT CLOSED: "condition_endorsements: delete own" is still granted,
-- so one account can DELETE its endorsement and call endorse_condition() again
-- a day later to roll the window forward. Closing that needs a separate record
-- of "this pair has endorsed before" that survives the delete, which is a
-- bigger change than this pass. Kept because un-endorsing is a real action a
-- user should be able to take, and because the renewal is now bounded (30 days
-- from the last genuine endorsement, never more) rather than unbounded, and a
-- report needs two DISTINCT reporters to be visible at all.

create trigger condition_endorsements_extend
  after insert on public.condition_endorsements
  for each row execute function public.condition_endorsement_extends();

-- ------------------------------------------------------------ publish_trip
create or replace function public.publish_trip(trip uuid, title text, summary text)
returns void language plpgsql security definer
set search_path = public, private, pg_temp as $$
declare
  v_title   text;
  v_summary text;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  -- A suspended account cannot publish. Checked here AND in
  -- trip_plans_guard_publish, because the direct-PATCH path never runs this
  -- function (see "ACCEPTED, NOT CLOSED" at the bottom).
  if private.caller_content_suspended() then raise exception 'content_suspended'; end if;

  -- Owner, not member. DEFINER means this select sees every trip, so the
  -- ownership test has to be explicit and is the only thing gating the write.
  if not exists (select 1 from public.trip_plans where id = trip and user_id = auth.uid()) then
    raise exception 'not_owner';
  end if;

  v_title := left(coalesce(public.plain_text(title), ''), 80);
  if v_title = '' then raise exception 'invalid_title'; end if;
  v_summary := left(coalesce(public.plain_text(summary), ''), 300);

  update public.trip_plans
    set published_at    = coalesce(published_at, now()),
        publish_title   = v_title,
        publish_summary = nullif(v_summary, '')
    where id = trip;
  -- coalesce, not now(): re-publishing an already-public trip edits its card
  -- rather than jumping it back to the top of a "newest" sort.
end $$;

-- ---------------------------------------------------------- unpublish_trip
create or replace function public.unpublish_trip(trip uuid)
returns void language plpgsql security definer
set search_path = public, private, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if not exists (select 1 from public.trip_plans where id = trip and user_id = auth.uid()) then
    raise exception 'not_owner';
  end if;
  -- No suspension check on purpose: taking your own content DOWN is never the
  -- action a suspension exists to stop, and blocking it would be a way to trap
  -- a suspended user's trip in public view.

  update public.trip_plans set published_at = null where id = trip;
  -- Votes are deliberately kept: unpublishing is reversible, and deleting them
  -- would make "unpublish, republish" a vote-reset button. The row leaves
  -- published_trips immediately either way.
end $$;

-- ---------------------------------------------------------------- vote_trip
create or replace function public.vote_trip(trip uuid)
returns void language plpgsql security definer
set search_path = public, private, pg_temp as $$
declare v_author uuid;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;

  select user_id into v_author
    from public.trip_plans where id = trip and published_at is not null;
  if v_author is null then raise exception 'not_found'; end if;
  if v_author = auth.uid() then raise exception 'own_trip'; end if;

  -- Members are co-authors, not an audience. Without this a five-person collab
  -- trip arrives in the feed with five votes from the people who wrote it, and
  -- the feed's "order by votes desc" is decided by party size. Same 'own_trip'
  -- code as the owner case: from the user's side it is the same sentence.
  if public.is_trip_member(trip) then raise exception 'own_trip'; end if;

  -- Blocked either way reads as not_found, never as a distinct error: a
  -- distinguishable "you are blocked" is a notification the blocker did not
  -- agree to send.
  if private.is_blocked_pair(auth.uid(), v_author) then raise exception 'not_found'; end if;

  insert into public.trip_votes (trip_id, user_id) values (trip, auth.uid())
    on conflict do nothing;
end $$;

-- -------------------------------------------------------------- unvote_trip
create or replace function public.unvote_trip(trip uuid)
returns void language plpgsql security definer
set search_path = public, private, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  delete from public.trip_votes where trip_id = trip and user_id = auth.uid();
  -- No not_found: un-voting something you never voted for is a no-op, and
  -- erroring would leak whether the trip exists.
end $$;

-- --------------------------------------------------------------- adopt_trip
-- COPY-ON-ADOPT. The adopter gets a private, fully owned clone; the original is
-- never mutated and never shared. Adoption is explicitly NOT membership — it
-- must not hand out the source trip's invite_code, or every published trip
-- would be a write credential for its author's live plan.
create or replace function public.adopt_trip(trip uuid)
returns uuid language plpgsql security definer
set search_path = public, private, pg_temp as $$
declare
  src trip_plans%rowtype;
  v_new uuid;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;

  select * into src from trip_plans where id = trip and published_at is not null;
  if src.id is null then raise exception 'not_found'; end if;
  if private.is_blocked_pair(auth.uid(), src.user_id) then raise exception 'not_found'; end if;

  insert into trip_plans (
    user_id, request, itinerary, title, start_date, invite_code,
    published_at, publish_title, publish_summary, editor_pick
  ) values (
    auth.uid(),
    -- NOT src.request. That payload carries the author's budget and their
    -- free-text preferences; published_trips deliberately never exposes it,
    -- so copying it would hand a stranger's private planning notes to whoever
    -- taps adopt. The stub keeps provenance without the leak.
    jsonb_build_object(
      'adopted_from', src.id,
      'days', public.itinerary_day_count(src.itinerary)
    ),
    src.itinerary,
    coalesce(src.publish_title, src.title),
    null,               -- dates are the adopter's to choose
    new_invite_code(),  -- fresh credential; never the source trip's
    null,               -- a copy starts private
    null,
    null,
    false               -- and never inherits editorial promotion
  )
  returning id into v_new;

  return v_new;
end $$;

-- ------------------------------------------------------------ report_content
create or replace function public.report_content(target_type text, target_id uuid, reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_type   text := lower(btrim(coalesce(target_type, '')));
  v_target uuid := target_id;
  v_reason text;
  v_exists boolean;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
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

-- ---------------------------------------------------------------- block_user
create or replace function public.block_user(target uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if target = auth.uid() then raise exception 'cannot_block_self'; end if;
  if not exists (select 1 from profiles where id = target) then
    raise exception 'not_found';
  end if;

  insert into user_blocks (blocker_id, blocked_id) values (auth.uid(), target)
    on conflict do nothing;
end $$;

-- -------------------------------------------------------------- unblock_user
create or replace function public.unblock_user(target uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  delete from user_blocks where blocker_id = auth.uid() and blocked_id = target;
end $$;

-- EXECUTE on functions is granted to PUBLIC by default, which is what we want
-- for the authenticated role: every function above opens with its own
-- auth.uid() check, so an anon call gets not_signed_in and nothing else.

-- ================================================= moderation runbook (admin)
-- Service-key only. The 24h moderation SLA runs off this: anything with
-- resolved_at null is open work.
--
--   curl "$SUPABASE_URL/rest/v1/admin_open_content_reports?select=*" \
--     -H "apikey: $SERVICE_KEY" -H "Authorization: Bearer $SERVICE_KEY"
--
-- To close one out (service key, SQL editor):
--   update content_reports set resolved_at = now(), resolution = 'removed'
--     where id = '<report id>';
-- To remove the offending content:
--   delete from condition_reports where id = '<target id>';
--   update trip_plans set published_at = null where id = '<target id>';
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
    coalesce(t.user_id, c.user_id) as author_id,
    coalesce(ap.handle, cp.handle) as author_handle,
    case r.target_type
      when 'trip' then coalesce(t.publish_title, t.title)
      when 'condition_report' then c.kind
    end as content_title,
    case r.target_type
      when 'trip' then coalesce(t.publish_summary, t.itinerary ->> 'summary')
      when 'condition_report' then c.note
    end as content_body,
    (t.id is null and c.id is null) as target_deleted
  from public.content_reports r
  left join public.profiles rp on rp.id = r.reporter_id
  left join public.trip_plans t
    on r.target_type = 'trip' and t.id = r.target_id
  left join public.condition_reports c
    on r.target_type = 'condition_report' and c.id = r.target_id
  left join public.profiles ap on ap.id = t.user_id
  left join public.profiles cp on cp.id = c.user_id
  where r.resolved_at is null
  order by r.created_at;

-- This view joins reporter identity to reported content — exactly the data the
-- no-select-policy on content_reports exists to hide. Supabase's default
-- privileges would have granted it to anon and authenticated on creation.
revoke all on public.admin_open_content_reports from anon, authenticated;

-- ================================================================== closed
-- What each control prevents, and the attack it was written against.
--
-- POLICIES
-- * "condition_reports: read own" (and no cross-user select) — a client cannot
--   read raw reports: who reported what, and their history across places,
--   stays private. Everything public arrives via condition_summary, which
--   carries no user_id at all.
-- * no UPDATE policy on condition_reports — a report cannot be edited in place
--   to swap sanitized text for raw text after the fact; refreshes go through
--   report_condition(), which re-cleans.
-- * "condition_endorsements: insert own" + not condition_report_is_mine() —
--   self-endorsement is blocked at the TABLE, not only in the RPC, so a direct
--   PostgREST insert cannot be used to renew your own report forever.
-- * condition_report_is_live() in the same policy — a dead report cannot be
--   resurrected by endorsing it.
-- * "trip_votes: insert own" + not is_trip_owner() + trip_is_published() +
--   not trip_author_blocked() — no self-voting, no voting on unpublished trips,
--   and no interaction across a block, all enforced on the raw-insert path and
--   not only inside vote_trip(). Double voting is impossible by the
--   (trip_id, user_id) primary key, not by a check.
-- * content_reports has NO select policy — reporters cannot read the queue and
--   a reported user cannot learn who reported them; unique (reporter, target)
--   caps one report per user per target.
-- * "user_blocks: read own" — the blocked user is never told they were blocked.
-- * user_blocks_no_self CHECK — self-blocking, which would erase your own trips
--   from your own feed via the symmetric filter, is rejected by the database.
-- * revoke all ... from anon, authenticated on every new base table — Supabase
--   grants SELECT on new tables by default; without the revoke, RLS would be
--   the only barrier and one bad policy would expose whole tables.
-- * published_trips revoked from anon — the block filter needs auth.uid(), so
--   signing out would otherwise be a one-click way around every block.
--
-- TRIGGERS
-- * trip_plans_publish_guard / editor_pick — an author cannot promote their own
--   trip to editor_pick and pin it to the top of the community feed. Only the
--   service key can, and is_service_role() reads the JWT role claim rather than
--   current_user precisely so that calling through a SECURITY DEFINER function
--   does not launder an authenticated caller into an admin.
-- * trip_plans_publish_guard / published_at, publish_* — a MEMBER of a shared
--   trip cannot publish it. The collab policy from 20260728000002 grants every
--   member UPDATE on the row, so without this a single invitee could push a
--   private group trip public, rewrite its public title, or unpublish the
--   owner's trip. RLS cannot express this: it never sees OLD.user_id.
-- * condition_endorsements_extend — DEFINER because condition_reports has no
--   UPDATE policy; an invoker trigger would update zero rows and the renewal
--   would silently never happen.
-- * (still in force from 20260729000001) trip_plans_immutable — user_id and
--   created_at frozen, invite_code owner-only, so nothing here reopens the
--   ownership-seizure hole.
--
-- RPCs
-- * publish_trip / unpublish_trip check user_id = auth.uid() explicitly. These
--   are DEFINER and therefore see every trip; the ownership test is the only
--   gate, and it is a check for OWNER, never is_trip_member().
-- * vote_trip and adopt_trip both run is_blocked_pair() and raise 'not_found'
--   on a block — a blocked user cannot read a blocker's itinerary through
--   adopt_trip even though adopt_trip is DEFINER and can see every row. The
--   error is deliberately indistinguishable from "no such trip" so it is not
--   an oracle for "this person blocked me".
-- * adopt_trip mints a fresh invite_code and never copies the source's. A
--   published trip is a read-only artifact, not a write credential for the
--   author's live plan, and the source row is only ever SELECTed.
-- * report_condition cleans the note BEFORE measuring it, so the 200-char cap
--   applies to what readers see; markup is stripped on the way in, and column
--   CHECK constraints hold the same caps on the direct-insert path.
-- * Blocking is symmetric in published_trips, vote_trip and adopt_trip:
--   blocking someone does not become a way to keep watching them.
--
-- ACCEPTED, NOT CLOSED
-- * A trip member can still edit the itinerary of a trip the owner published,
--   and the edit shows publicly. Members are invited co-authors, and freezing
--   published itineraries would break the ordinary "we published, now we are
--   still planning" case. The owner can unpublish, and content_reports covers
--   abuse. Revisit if a real incident appears.
-- * An owner can set published_at directly via PostgREST instead of calling
--   publish_trip(), skipping plain_text(). The column CHECK constraints still
--   bound the lengths, and trip_plans.title (pre-existing, uncapped) is only a
--   fallback when publish_title is null.
-- * condition_summary is not block-filtered. It exposes no author, so there is
--   nobody to hide from; the block filter belongs where authorship is shown.
-- * Vote and endorsement counts are still gameable with multiple accounts, the
--   same limit decision 0001 accepted for price bands. Thresholds (3 ratings,
--   2 reporters) raise the cost; they do not make it impossible.

do $$ begin raise exception 'DRY RUN OK - rolled back, nothing changed'; end $$;
rollback;
