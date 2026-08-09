-- v1.1 Crowdsourced green-fee price bands (docs/decisions/0001-price-crowdsourcing.md).
--
-- Users submit one coarse band from a fixed four-value enum, never a number and
-- never free text. Nothing is shown until three INDEPENDENT accounts have
-- reported, and what is shown is an aggregate with no author attached. Raw rows
-- are owner-only forever: who paid what stays private.
--
-- Shape follows 20260808000001_community.sql exactly, including the three
-- lessons its security review produced:
--
--   1. An RPC is only the sanctioned write path if it is the ONLY write path.
--      INSERT is therefore revoked from anon and authenticated outright (H1/H2
--      in that review), and a BEFORE trigger re-derives the server-owned columns
--      so the invariants hold even on a path that skips the RPC entirely.
--   2. The aggregate view is security_invoker = false. An invoker view over an
--      RLS-locked table runs under the caller's RLS, sees only their own rows,
--      and returns nothing — the aggregate would be permanently empty. Decision
--      0001 documents this trap; it is not an oversight.
--   3. The one-per-user unique is a NAMED CONSTRAINT, not a bare unique index,
--      so the RPC can write ON CONFLICT ON CONSTRAINT <name>. Naming the columns
--      in an inference clause fails inside plpgsql here: the function parameter
--      is called `place` and `band`, and plpgsql's default variable_conflict =
--      error turns an ambiguous column reference into a runtime failure. The
--      community migration hit exactly this.
--
-- DEVIATION FROM DECISION 0001, deliberate and cosmetic: the ADR sketched the
-- view as place_report_aggregates(place_id, kind, value, report_count). It ships
-- as place_price_stats(place_id, band, report_count) — a price-specific
-- projection, named like its sibling place_rating_stats, with `kind` filtered
-- rather than grouped. The TABLE stays generic (kind + value) exactly as the ADR
-- intended, so a v1.2 signal (walkability, pace) reuses the table, the RPC
-- pattern and the trigger, and gets its own narrow view. A view whose columns
-- mean different things depending on a `kind` value the client has to filter on
-- is a worse contract than one view per signal.

-- ============================================================== place_reports
-- One structured report per user per place per kind. The client has NO insert
-- privilege (see grants): report_place_price() is the only writer, and
-- place_reports_sanitize re-derives value/kind/created_at on every path anyway.
create table public.place_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  place_id uuid not null references public.places (id) on delete cascade,
  -- enum-by-check rather than a single-purpose table, per decision 0001: v1.2
  -- signals reuse this pipeline by widening the check, with no new migration
  -- shape to invent. Exactly one member today.
  kind text not null check (kind in ('green_fee_band')),
  -- Four members, identical to the golf skin's greenFeeBand enum
  -- (packages/skins/golf/src/index.ts) so a reported band and a sourced band are
  -- the same vocabulary on screen. The CHECK is the immovable backstop: even a
  -- service-key insert cannot store a fifth value, so there is no free text
  -- anywhere in this feature and therefore nothing to moderate.
  value text not null check (value in ('$', '$$', '$$$', '$$$$')),
  created_at timestamptz not null default now(),
  -- NAMED, for the ON CONFLICT ON CONSTRAINT reason at the top of this file.
  -- It is also the ballot-stuffing defence: one account is one vote per place,
  -- enforced by the database rather than by the RPC.
  constraint place_reports_one_per_kind unique (user_id, place_id, kind)
);

-- Hot path: the app reads place_price_stats filtered by place_id, and batches
-- with place_id = any(...) when a list screen needs several at once. The view's
-- aggregate is grouped BY place_id, so the planner pushes an equality or
-- ANY-array qual on place_id down into the group — but only if there is an index
-- with place_id LEADING. Without one, every place page is a sequential scan of
-- every report in the table; that is the same miss the M8.4 audit found on
-- place_logs (fixed there by place_logs_place_rating_idx).
--
-- user_id and value trail so count(distinct user_id) and mode() over value can
-- be answered from the index without touching the heap.
--
-- The predicate is IMMUTABLE — a comparison against a literal. Postgres refuses
-- non-immutable index predicates, which is why condition_reports could not have
-- a partial index on "live" rows (it would have needed now()). Nothing here
-- wants a time-varying predicate, so the partial index is free: it keeps the
-- price path indexing only price rows once v1.2 adds other kinds.
create index place_reports_band_idx
  on public.place_reports (place_id, user_id, value)
  where kind = 'green_fee_band';

-- Second index, not for reads: deleting an account cascades to this table, and
-- account deletion is a one-tap action (supabase/functions/delete-account).
-- Without a user_id-leading index that cascade is a full scan per deleted user.
create index place_reports_user_idx on public.place_reports (user_id);

alter table public.place_reports enable row level security;

-- Default deny, then owner-only. There is deliberately NO cross-user select
-- policy: an individual's report is never readable through the API by anyone
-- but its author. Everything public arrives via place_price_stats, which
-- carries no user_id at all.
create policy "place_reports: read own" on public.place_reports
  for select using (auth.uid() = user_id);
create policy "place_reports: update own" on public.place_reports
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "place_reports: delete own" on public.place_reports
  for delete using (auth.uid() = user_id);
create policy "place_reports: insert own" on public.place_reports
  for insert with check (auth.uid() = user_id);
-- The read-own policy is what decision 0001 anticipated ("if the log UI later
-- needs to prefill a user's own previous band"): the capture sheet can show the
-- user the band they last reported without any RPC, and still cannot see anyone
-- else's.
--
-- The INSERT policy is a SECOND GATE, not the barrier: INSERT is not granted to
-- authenticated at all (see grants). It is kept so that re-granting the
-- privilege by accident does not simultaneously drop the "the row is yours"
-- check. The reason the grant went away is the H1/H2 finding: an insert policy
-- can say "this row is yours", but it cannot say "created_at is a server value"
-- or "the band was validated", so a direct POST could store a back- or
-- future-dated row — which is invisible today and becomes an exploit the moment
-- decision 0001's deferred recency window lands and created_at starts deciding
-- which reports count.

-- ========================================================= write-path trigger
-- Belt and braces behind the revoked INSERT privilege. A revoke is a
-- configuration; a trigger is a property of the table. This fires on every path
-- — RPC, service key, psql, or a grant somebody restores in six months — and it
-- is what makes "the stored band is one of four literals and created_at is a
-- server value" a true statement about the TABLE rather than a statement about
-- report_place_price().
--
-- DOLLAR-QUOTE TAG: $fn$, not the bare $$ every other function in this repo
-- uses, and this one is not stylistic. Dollar quoting has no escape mechanism —
-- the body ends at the very next occurrence of the opening tag, and single
-- quotes inside it are ordinary characters with no special meaning. This body
-- contains the literals '$$', '$$$' and '$$$$', so with a $$ tag the function
-- would be truncated mid-statement and the migration would fail with a syntax
-- error at deploy time. Both functions in this file are tagged for that reason;
-- it is a property of the band vocabulary, so any future edit that keeps dollar
-- signs in the enum has to keep the tag.
create or replace function public.place_reports_sanitize()
returns trigger language plpgsql
set search_path = public, private, pg_temp as $fn$
begin
  -- Same normalisation report_place_price() applies, re-applied here. Trimming
  -- before the CHECK means ' $$ ' is stored as a valid '$$' instead of failing
  -- with a raw constraint-violation error the client cannot switch on.
  new.kind  := lower(btrim(coalesce(new.kind, '')));
  new.value := lower(btrim(coalesce(new.value, '')));

  if new.kind not in ('green_fee_band') then raise exception 'invalid_kind'; end if;
  if new.value not in ('$', '$$', '$$$', '$$$$') then raise exception 'invalid_band'; end if;

  if tg_op = 'INSERT' then
    -- Server fact, never client input.
    new.created_at := now();
  else
    -- UPDATE reaches here from report_place_price()'s ON CONFLICT refresh (which
    -- sets created_at = now()) and from a direct owner PATCH. Clamp rather than
    -- pin, exactly as condition_reports_sanitize does: nothing may claim to have
    -- been created later than now, and an UPDATE that does not mention
    -- created_at keeps the value it had.
    new.created_at := least(new.created_at, now());
  end if;

  return new;
end $fn$;

-- BEFORE INSERT matters for more than validation: the ON CONFLICT ON CONSTRAINT
-- place_reports_one_per_kind inference in report_place_price() runs on the
-- POST-trigger row, so the trimmed kind is what gets matched. Without that,
-- 'green_fee_band ' and 'green_fee_band' would miss each other and one user
-- could hold two rows on the same place — two "reporters" in the aggregate from
-- one person, which is precisely what the threshold exists to prevent.
create trigger place_reports_sanitized
  before insert or update on public.place_reports
  for each row execute function public.place_reports_sanitize();

-- ========================================================== place_price_stats
-- The only public surface. security_invoker = false for the reason at the top:
-- the base table is revoked from clients and has no cross-user select policy, so
-- an invoker view would return zero rows for everybody, forever.
create view public.place_price_stats
with (security_invoker = false) as
  select
    place_id,
    mode() within group (order by value) as band,
    count(distinct user_id)::int as report_count
  from public.place_reports
  where kind = 'green_fee_band'
  group by place_id
  having count(distinct user_id) >= 3;
-- count(DISTINCT user_id), not count(*), in BOTH the output and the gate. They
-- have to be the same expression: if the displayed number could ever exceed the
-- number of accounts the threshold counted, the count would be advertising a
-- consensus the gate never checked. (The unique constraint already makes them
-- equal; writing it out means a future kind, or a constraint someone relaxes,
-- cannot silently separate them.)
--
-- No user_id and no individual values in the output — the reporters are
-- anonymous to readers, which is also why this view needs no block filter:
-- there is no author to attribute a band to and nothing to follow back to a
-- person.
--
-- TIE-BREAKING, stated because it is not obvious: mode() returns the first of
-- the most-frequent values in the given sort order. Ascending over these four
-- literals is '$' < '$$' < '$$$' < '$$$$', so a tie resolves to the CHEAPER
-- band. At the floor of three reporters a 2-1 split has a real winner, but a
-- 1-1-1 split has none and this view will still publish a band. ACCEPTED, not
-- closed: decision 0001 chose mode-of-three knowing it "absorbs" a wrong band
-- rather than eliminating it, the output is labelled as user-reported opinion
-- and never as a price, and the alternative (suppress rows with no plurality)
-- makes an already-sparse feature sparser at launch for a display that is
-- advisory either way. Revisit alongside the recency window.
--
-- HONEST STATEMENT OF WHAT THE THRESHOLD DOES AND DOES NOT DO. It is a
-- k-anonymity floor, not a guarantee that an individual's answer is
-- unrecoverable, and at the boundary it is genuinely recoverable:
--
--   * At exactly report_count = 3, an attacker who knows TWO of the three
--     reporters and their bands can often read the third off this view. If the
--     two known bands differ, the published mode is whichever band appears
--     twice, which names the third reporter's answer exactly; if all three
--     differ, the tie-break above narrows it to the values above the published
--     one. Only when the two known bands already agree does the third stay
--     hidden.
--   * Watching report_count tick from 3 to 4 and seeing `band` move likewise
--     narrows the new reporter's answer.
--
-- What keeps this from mattering: the attacker must already know WHO reported
-- and WHAT they said, and this schema never tells them — place_reports has no
-- cross-user select policy, no client select grant, and the view carries no
-- user_id, so that knowledge has to come from outside the system (the reporter
-- telling them). The recovered secret is one of four coarse bands about a golf
-- course's green fee — the least sensitive attribute in this database. The real
-- defences are the floor of 3 and the owner-only raw table; nothing here should
-- be read as differential privacy, because it is not.

-- ================================================================== grants
-- Supabase's default privileges hand SELECT on new objects to anon and
-- authenticated, so the base table has to be revoked explicitly first; otherwise
-- the RLS policies above are the only thing standing between a client and every
-- user's raw reports, and the "aggregates public, rows private" split collapses
-- on the first policy mistake.
revoke all on public.place_reports from anon, authenticated;

-- SELECT, UPDATE and DELETE only. INSERT is withheld under the rule the M8.4
-- review established: a client may insert directly only where the insert policy
-- can express EVERY invariant the RPC enforces, and an RLS WITH CHECK cannot
-- stamp created_at or validate a normalised band.
grant select, update, delete on public.place_reports to authenticated;

-- Explicit re-revoke, so the intent survives someone adding a role-level grant
-- later without reading this block.
revoke insert on public.place_reports from anon, authenticated;

-- WHY direct UPDATE and DELETE are safe to keep, while INSERT is not: with
-- place_reports_sanitized in force, the only things a direct owner PATCH can
-- change are `value` (to another of the four literals — the same act the RPC
-- performs) and `place_id` (equivalent to deleting the row and reporting
-- elsewhere, which DELETE already allows). user_id cannot be reassigned: the
-- update policy's WITH CHECK pins it to auth.uid() on the new row as well as the
-- old. created_at is clamped by the trigger. DELETE is a user withdrawing their
-- own report, which must stay possible.

revoke all on public.place_price_stats from anon, authenticated;
grant select on public.place_price_stats to anon, authenticated;
-- ANON READS THIS, deliberately, and unlike published_trips. The rule the M8.4
-- review settled on: a definer view may be granted to anon only if it does no
-- per-caller filtering. published_trips was withheld because its block filter
-- keys off auth.uid(), so signing out silently evaporated every block. This view
-- has no auth.uid() anywhere in it, exposes no user_id, and returns byte-identical
-- rows to every caller — signing out gains an attacker exactly nothing. Granting
-- anon matches its siblings place_rating_stats and condition_summary, and keeps
-- a place page renderable before sign-in, which is the point of having a public
-- catalog at all.

-- ==================================================================== RPC
-- SECURITY DEFINER with a pinned search_path, re-checking auth.uid() itself, and
-- raising the short stable codes the mobile client already switches on:
--
--   not_signed_in | content_suspended | invalid_band | not_found
--
-- Only invalid_band is new; the other three are already in the client's
-- vocabulary from 20260808000001. Parameter names are the PostgREST wire
-- contract; locals are prefixed v_ so nothing collides with a column name.
--
-- NOTE on search_path: written as `public, private, pg_temp` rather than the
-- bare `public` used by the oldest RPCs in 20260808000001. That is the migration's
-- own stated convention for everything written after its security review —
-- `private` so private.caller_content_suspended() resolves alongside its
-- siblings, and pg_temp LAST so a caller cannot shadow an unqualified relation
-- name with a temp object. Every reference below is schema-qualified anyway, so
-- resolution never depends on the order; this is the belt to that suspenders.
--
-- $fn$ tag again, for the reason spelled out above place_reports_sanitize():
-- this body contains '$$' / '$$$' / '$$$$' literals and a bare $$ tag would
-- terminate it early.
create or replace function public.report_place_price(place uuid, band text)
returns void language plpgsql security definer
set search_path = public, private, pg_temp as $fn$
declare
  v_band text;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  -- A moderator-suspended account cannot contribute, same as report_condition()
  -- and publish_trip(). A band is not text, but it does reach other users'
  -- screens once three accounts agree, so it is content.
  if private.caller_content_suspended() then raise exception 'content_suspended'; end if;

  -- Normalise, then reject STRICTLY. Deliberately not plain_text(): that helper
  -- exists to make free text safe to display, and cleaning input into validity
  -- is the wrong instinct for a four-member enum — '<b>$$</b>' is not a band, it
  -- is a client that is broken or probing, and it should be told so. Trim and
  -- case-fold only, then an exact membership test.
  v_band := lower(btrim(coalesce(band, '')));
  if v_band not in ('$', '$$', '$$$', '$$$$') then raise exception 'invalid_band'; end if;

  -- Explicit existence check rather than letting the foreign key fire: the FK
  -- violation surfaces to PostgREST as a 23503 with a constraint name in it,
  -- which the client cannot switch on. DEFINER is not needed to see the row
  -- (places is publicly readable) but the check still belongs here so the error
  -- code is part of the contract.
  if not exists (select 1 from public.places where id = place) then
    raise exception 'not_found';
  end if;

  -- Upsert-refresh, so a user CORRECTS their answer rather than stacking a
  -- second row next to it. The conflict can only ever be with the caller's own
  -- row: user_id is part of the constraint and is always auth.uid() here, so
  -- DEFINER cannot be steered into overwriting a stranger's report.
  --
  -- ON CONFLICT ON CONSTRAINT, not ON CONFLICT (user_id, place_id, kind): the
  -- parameter `place` and the column `place_id` do not collide, but `band` and a
  -- future column would, and the community migration proved that plpgsql's
  -- variable_conflict = error turns that into a runtime failure discovered in
  -- production rather than at deploy time. The named constraint has no such
  -- failure mode at any point in the table's future.
  insert into public.place_reports (user_id, place_id, kind, value)
  values (auth.uid(), place, 'green_fee_band', v_band)
  on conflict on constraint place_reports_one_per_kind do update
    set value      = excluded.value,
        created_at = now();
  -- created_at = now() on correction is intentional: a corrected band is a fresh
  -- opinion, and it is the value decision 0001's deferred recency window will
  -- read. The trigger clamps it either way, so this cannot be pushed forward.
end $fn$;

-- EXECUTE on functions is granted to PUBLIC by default, which is what we want:
-- the function opens with its own auth.uid() check, so an anon call gets
-- not_signed_in and nothing else.

-- ====================================================== rate cap: NOT ADDED
-- Checked against the applied schema, and deliberately not implemented here.
--
-- 20260808000003 added a per-reporter flood cap to report_content() because the
-- unique constraint on content_reports caps repeats per TARGET while nothing
-- capped them per REPORTER, and the resource being flooded was a HUMAN
-- MODERATION QUEUE under a 24h SLA. One account filing against thousands of
-- distinct targets converted an API call into unbounded staffing cost.
--
-- Nothing analogous exists here, on either axis:
--
--   * There is no queue and no notification. place_reports feeds exactly one
--     consumer, place_price_stats, and nothing else reads it. A flood creates
--     no work for anybody.
--   * A flood buys the attacker no visible effect. The view gates on
--     count(distinct user_id) >= 3, so one account's reports are invisible no
--     matter how many places they cover — the cap that matters here is the
--     unique constraint, and it is on the axis the attacker actually needs.
--   * Volume is bounded by construction. One account can hold at most one row
--     per place, and places is an ETL-loaded catalog of finite size, so a single
--     account's maximum footprint is |places| invisible rows. Repeat submissions
--     UPDATE in place and add nothing at all.
--   * The cost is real but wrong-shaped. A ledger costs a DELETE + COUNT +
--     INSERT on every single price report — write amplification on the hot happy
--     path of a one-tap capture flow — to defend against generic write volume,
--     which is a gateway rate-limit concern, not a per-feature one.
--
-- REVISIT IF any of these become true: place_reports gains a kind that a human
-- reads or that notifies someone; the recency window lands and makes churn
-- valuable (a stale report aging out and being re-filed would then be worth
-- rate-limiting); or the table ever gains a client-visible per-report surface.
-- The ledger pattern (report_attempts / join_attempts) is a drop-in at that
-- point and does not need this table to change.

-- ================================================================== closed
-- Each attack considered, and whether it is closed or accepted.
--
-- CLOSED
-- * Direct PostgREST insert. `revoke all` + an explicit `revoke insert` leave no
--   client role able to POST /place_reports, so report_place_price() is the only
--   write path — and place_reports_sanitized enforces the same invariants even
--   if a grant is ever restored. This is the H1/H2 finding from the community
--   review, closed at the start rather than in a follow-up.
-- * Client-controlled created_at. Stamped on INSERT and clamped on UPDATE by the
--   trigger, on every path including the service key. It is invisible today and
--   load-bearing the moment a recency window lands; back-dating it now would
--   have been a dormant exploit.
-- * Value injection / free text. `value` is one of four literals, enforced by a
--   column CHECK, re-enforced by the trigger, and validated a third time in the
--   RPC. No free text exists anywhere in this feature, so there is no markup to
--   strip, no XSS surface, and no moderation queue by construction. No dynamic
--   SQL is built anywhere, so the band string is never interpreted.
-- * DEFINER steered into writing someone else's row. user_id is always
--   auth.uid(); it is part of the unique constraint, so the ON CONFLICT target
--   is provably the caller's own row.
-- * One user inflating a band. The named unique constraint makes one account one
--   vote per place, and the view gates on count(DISTINCT user_id), so a single
--   account can never move a place from invisible to visible, nor swing a band
--   it has already voted on by voting again (the upsert replaces).
-- * Reading who reported what. No cross-user select policy, no client select
--   grant on the base table, no user_id in the view. An individual's report is
--   unreadable through the API by anyone but its author.
-- * Empty-aggregate trap. The view is security_invoker = false; as an invoker
--   view over this RLS-locked table it would return zero rows to every caller
--   forever, and the feature would look "sparse" rather than broken.
-- * Missing-index scan. place_reports_band_idx leads on place_id, which is what
--   both `place_id = eq` and `place_id = any(...)` need; the predicate is
--   immutable so Postgres will accept it and the planner can prove the view's
--   own WHERE implies it.
--
-- ACCEPTED, NOT CLOSED
-- * Threshold inference at the boundary. At exactly three reporters, an attacker
--   who already knows two of them and their bands can usually recover the third
--   — see the HONEST STATEMENT on the view. Accepted because the prerequisite
--   knowledge cannot be obtained from this schema, and because the secret is one
--   of four coarse bands about a green fee. Decision 0001 fixed the floor at 3;
--   raising it or adding noise is the only real fix and both make an
--   already-sparse launch feature sparser.
-- * Sock puppets. Three accounts controlled by one person clear the threshold
--   and set any band they like. The same limit decision 0001 accepted, and the
--   same one the community layer accepted for votes and endorsements:
--   thresholds raise the cost, they do not make it impossible. Nothing short of
--   identity verification closes it, and the payoff — a wrong "$$" on one course
--   page, labelled as user-reported — does not justify that.
-- * No plurality requirement. A 1-1-1 split at the floor publishes the cheapest
--   band with no consensus behind it. See the tie-breaking note on the view.
-- * Stale reports after a real price change. There is no recency window in v1.1,
--   so a course that raises its fees carries its old modal band until enough new
--   reporters outnumber the accumulated old ones, and old reports never expire.
--   Explicitly deferred by decision 0001 ("revisit at 50k reports: if the mode is
--   unstable across seasons, add a recency window rather than a moderation
--   layer"). What this migration does about it is make the fix a pure view
--   change later: created_at is collected on every row and is server-stamped and
--   clamped, so it can be trusted as a filter the day someone wants it.
-- * A user can silently swap their band. The upsert overwrites, keeping no
--   history, so nothing records that someone reported '$' and later '$$$$'. That
--   is the intended privacy posture (we keep the current opinion, not a dossier)
--   and it means the aggregate can move without any audit trail. Accepted.
