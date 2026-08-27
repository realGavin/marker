-- ATOMIC: this migration DROPS and recreates both live condition views, drops
-- two helper functions and swaps an index. It is applied by hand, so it must not
-- depend on the client wrapping it -- a failure partway through would otherwise
-- leave production with condition_summary and place_condition_flags gone, the
-- mobile place page and map flags dark, and no down path. Nothing below is
-- transaction-hostile: no CREATE INDEX CONCURRENTLY, no DROP INDEX CONCURRENTLY,
-- no ALTER TYPE ADD VALUE, no VACUUM, no dblink. One transaction is safe.
--
-- RE-RUNNABLE, but note WHY: the two `create view` statements below are bare,
-- not `create or replace`. They are safe only because the matching
-- `drop view if exists` runs before them. Everything else is `create or
-- replace` / `... if not exists` / `drop ... if exists`. So a retry is a no-op
-- as long as that drop-before-create order is preserved -- do not reorder the
-- drops below the creates on the assumption that every statement guards itself.
begin;

-- ============================================================================
-- v1.2 Condition DISTRIBUTION: publish the counts, not a verdict.
--
-- THE PROBLEM WITH v1.1. 20260810000001 (APPLIED -- not edited by this file)
-- made condition_summary publish a single modal verdict with ties resolved
-- toward the worse score. That collapses disagreement: "1 poor, 1 good" and
-- "10 poor, 1 good" both render as "Poor". A golfer reading "Poor" cannot tell
-- whether one person is annoyed or the whole field agrees, and the view gives
-- them nothing to judge with.
--
-- WHAT REPLACES IT. The raw distribution -- "10 reported poor condition within
-- the past two weeks, 6 reported okay". Three properties follow, and they are
-- the whole justification:
--   1. HONEST. Nothing is collapsed. The reader sees the evidence, not our
--      summary of it.
--   2. SELF-CALIBRATING. "12 poor / 1 good" and "1 poor / 1 good" look as
--      different on screen as they are in reality. v1.1 needed a `reporters`
--      column next to the verdict and a mobile-side convention to achieve a
--      weaker version of this; here it is intrinsic.
--   3. IT DELETES A RULE. The tie-break ("ties resolve toward the worse score")
--      and the pair of helper functions that expressed it are GONE, and with
--      them the ACCEPTED-NOT-CLOSED risk v1.1 carried: at exactly two
--      reporters, one dissenter could flip the published verdict to 'poor'.
--      There is no verdict left to flip.
--
-- THIS SUPERSEDES v1.1's design. condition_reports.score, report_condition(),
-- condition_reports_sanitize(), the CHECK constraint and every write-path
-- guarantee from 20260810000001 are UNCHANGED and are not restated here. Only
-- the read surface changes.
--
-- BREAKING CHANGE FOR MOBILE, deliberate and coordinated. Both views change
-- shape. condition_summary loses `score` and gains five integer columns;
-- place_condition_flags loses `worst_score` and gains `poor_count`. Exact new
-- signatures are stated at each view. apps/mobile/src/lib/data.ts
-- (useConditions, useFlaggedPlaces) must ship in the same release.
--
-- STATIC REVIEW ONLY. There is no local Postgres on this machine. Nothing here
-- has been executed, EXPLAINed or tested against a live database; everything
-- below is a static reading of the applied SQL plus the documented behaviour of
-- the constructs used. Gavin applies migrations by hand -- treat the first
-- apply as the first execution.
-- ============================================================================


-- ================================================================== windows
-- TWO DIFFERENT CLOCKS, ON PURPOSE. DO NOT "SIMPLIFY" THEM TOGETHER.
--
--   * RETENTION: expires_at, created_at + 30 days, extended by endorsement.
--     This governs when a ROW DIES. It is enforced on the write path
--     (condition_reports_sanitize) and consumed by endorse_condition() and
--     condition_endorsement_extends(). Untouched by this migration.
--
--   * DISPLAY: created_at > now() - interval '14 days'. This governs what is
--     COUNTED for the public surface, and nothing else.
--
-- They are deliberately different numbers so they cannot be mistaken for the
-- same rule. The reason for the split: the UI says "in the past two weeks", and
-- that sentence has to be literally true. Filtering on expires_at made it a lie
-- in two directions -- a report could be 29 days old and still counted, and an
-- endorsed report could be counted 40+ days after it was written, because
-- endorsing pushes expires_at forward. Course conditions do not keep for a
-- month; aeration recovers, bunkers get raked.
--
-- If you are reading this because you want to delete one of them: collapsing to
-- expires_at breaks the "past two weeks" copy and re-opens the endorsement
-- immortality path below. Collapsing to created_at everywhere means rows die at
-- 14 days, which shortens the endorse target's life and changes what
-- endorse_condition() calls 'not_found'. Neither is a simplification; both are
-- behaviour changes. Change the number here if two weeks is wrong -- but keep
-- the two clocks separate.
--
-- CONSEQUENCE, STATED PLAINLY: endorsement-extension NO LONGER DRIVES THE
-- HEADLINE COUNTS. Under v1.1, endorsing a report pushed its expires_at out and
-- therefore kept it inside the aggregate. Under this file, a report drops out of
-- the counts 14 days after it was WRITTEN no matter how many people endorse it.
-- That is the intended behaviour (a two-month-old endorsement chain should not
-- keep a stale "poor" on a course's map pin), and it is exactly why endorsements
-- need their own column below -- see `endorsements`.
--
-- The literal `now() - interval '14 days'` is repeated inline rather than
-- factored into a helper function. A STABLE SQL helper would be inlinable and
-- would probably still allow the index-scan qualifier, but "probably" is not
-- something to discover on a hand-applied migration against a database nobody
-- here can EXPLAIN first. Four copies of one literal, all inside this one view.


-- ================================================================ teardown
-- Flags depends on summary, so it goes first. Both are `if exists` so the file
-- re-runs cleanly, and both are DROPped rather than CREATE OR REPLACEd: a
-- replacement may only APPEND columns to a view, and this change REMOVES `score`
-- from summary and `worst_score` from flags. CREATE OR REPLACE VIEW cannot do
-- that -- it would fail with "cannot drop columns from view".
drop view if exists public.place_condition_flags;
drop view if exists public.condition_summary;


-- ========================================================= condition_summary
-- SIGNATURE (this is the contract apps/mobile codes against):
--
--   place_id         uuid
--   kind             text
--   poor_count       int          distinct users who reported 'poor'
--   ok_count         int          distinct users who reported 'ok'
--   good_count       int          distinct users who reported 'good'
--   reporters        int          distinct users total  (= the three above)
--   endorsements     int          distinct users who endorsed but did NOT report
--   latest_note      text         note from the freshest counted report
--   latest_at        timestamptz  freshest counted report's created_at
--   expires_at       timestamptz  retention horizon -- NOT the display window
--   latest_report_id uuid         the endorse target (unchanged from v1.1)
--
-- THE THREE COUNTS SUM TO `reporters`, EXACTLY. That is not a coincidence to be
-- checked at runtime, it is guaranteed by condition_reports_one_per_user unique
-- (user_id, place_id, kind): one account is exactly one row per (place, kind),
-- so the per-score distinct-user sets are disjoint and partition the group. The
-- mobile side may rely on it. If that constraint is ever relaxed, this invariant
-- and the >= 2 floor both break -- the constraint is load-bearing for the whole
-- surface, not just for the headcount.
--
-- count(DISTINCT user_id) IN EVERY COUNT AND IN THE GATE. They have to be the
-- same expression, or the numbers on screen would advertise a consensus the gate
-- never checked. Carried over from v1.1 unchanged.
--
-- THE >= 2 DISTINCT REPORTERS FLOOR SURVIVES THIS REWRITE UNCHANGED, and it is
-- the single most important line in the file. It is the only thing preventing
-- one account from publicly flagging a golf course. It is expressed once, here,
-- and place_condition_flags inherits it rather than restating it, so the two
-- surfaces cannot drift into disagreeing about what is public.
--
-- SINGLE-LEVEL AGGREGATION, kept from v1.1 for the same reason: a CTE holding
-- "live rows" would be referenced more than once and therefore MATERIALIZED
-- (PG12+), which blocks qualifier pushdown, and
-- `condition_summary?place_id=eq.X` -- useConditions, i.e. every place page --
-- would aggregate every recent report in the table into a tuplestore before
-- filtering. The form below keeps `place_id = X` pushed down to an index scan.
create view public.condition_summary
with (security_invoker = false) as
  select
    r.place_id,
    r.kind,

    -- FILTER, not `count(distinct case when ... then user_id end)`. Identical
    -- result; FILTER says what it means. Each is a DISTINCT count in its own
    -- right, so a user cannot appear twice in one bucket even if the unique
    -- constraint were somehow relaxed -- the counts degrade to "distinct people
    -- who said X" rather than to nonsense.
    (count(distinct r.user_id) filter (where r.score = 'poor'))::int as poor_count,
    (count(distinct r.user_id) filter (where r.score = 'ok'))::int   as ok_count,
    (count(distinct r.user_id) filter (where r.score = 'good'))::int as good_count,
    count(distinct r.user_id)::int                                   as reporters,

    -- ------------------------------------------------------- endorsements
    -- WHY THIS COLUMN EXISTS. Endorsement's only effect was extending
    -- expires_at. This file stops reading expires_at for display, so without
    -- this column endorsing would become an invisible no-op: a real action, a
    -- real button in the app, with zero effect on anything a reader can see.
    -- Rather than leave it meaningless, endorsement becomes what its copy
    -- already claims it is -- a second voice -- and gets counted as one.
    --
    -- WHY NOT the alternative (promote an endorsement to a full vote for the
    -- endorsed report's score, folding it into poor_count/ok_count/good_count):
    -- rejected, and the reason matters. Endorsing is ONE TAP on someone else's
    -- report; reporting is a deliberate act of stating a score yourself. Mixing
    -- them would let the cheaper action inflate the expensive number, and it
    -- would let two endorsers push a group over the >= 2 floor -- destroying the
    -- guarantee that publication requires two INDEPENDENT reports. Endorsements
    -- are reported alongside the distribution, never inside it. "6 poor · 2 ok ·
    -- 3 agreed" is three separate facts and the app should render them that way.
    --
    -- DISJOINT FROM `reporters`, via the NOT EXISTS. A user who filed their own
    -- report on this (place, kind) is already in poor/ok/good_count; nothing
    -- stops them ALSO endorsing another user's report of the same kind
    -- (endorse_condition only forbids endorsing your OWN report), and counting
    -- them in both would make "6 poor · 3 agreed" mean fewer than nine people.
    -- So `endorsements` reads as "additional people who corroborated without
    -- filing their own report", and reporters + endorsements is a true headcount
    -- of distinct humans behind the row.
    --
    -- ONE PERSON, AT MOST ONE ENDORSEMENT PER GROUP, regardless of how many of
    -- the group's reports they endorse: the count is DISTINCT on e.user_id, and
    -- the group can hold several reports. No volume play here.
    --
    -- BOTH ENDS INSIDE THE 14-DAY WINDOW: the endorsement itself must be recent
    -- (e.created_at), AND it must be attached to a report that is itself being
    -- counted (er.created_at). Without the second condition, endorsements of
    -- aged-out reports would keep inflating a group whose reports no longer
    -- appear in any of the three buckets.
    --
    -- COST: this is a correlated subplan, evaluated once per OUTPUT GROUP -- not
    -- per row and not per table scan. Output groups are, by construction, only
    -- those that cleared the >= 2 floor. Each evaluation is an index probe on
    -- condition_reports_window_idx (place_id, kind, created_at) for the group's
    -- reports, a primary-key prefix probe on condition_endorsements
    -- (report_id, user_id) per report, and an exact three-column probe on
    -- condition_reports_one_per_user (user_id, place_id, kind) per candidate
    -- endorser. No new index is needed for any of the three.
    --
    -- The outer references r.place_id and r.kind are both GROUP BY keys, which
    -- is what makes a subquery legal in the target list of a grouped query.
    (
      select count(distinct e.user_id)
      from public.condition_endorsements e
      join public.condition_reports er on er.id = e.report_id
      where er.place_id = r.place_id
        and er.kind     = r.kind
        and er.created_at > now() - interval '14 days'
        and e.created_at  > now() - interval '14 days'
        and not exists (
          select 1
          from public.condition_reports own
          where own.user_id  = e.user_id
            and own.place_id = r.place_id
            and own.kind     = r.kind
            and own.created_at > now() - interval '14 days'
        )
    )::int as endorsements,

    -- The latest_* trio is carried over from v1.1 character-for-character
    -- (modulo the `r.` alias), including the created_at desc, id desc tie-break,
    -- so the only things a reviewer has to reason about are the new counts. All
    -- three still describe THE SAME ROW -- the invariant
    -- apps/mobile/src/lib/data.ts documents and endorsing depends on.
    (array_agg(r.note order by r.created_at desc, r.id desc))[1] as latest_note,
    max(r.created_at) as latest_at,

    -- RETAINED, BUT ITS MEANING NARROWED. This is now the retention horizon of
    -- the group's longest-lived counted row and nothing more: it does NOT say
    -- how long these counts will be displayed. Under this file a group stops
    -- being counted 14 days after its newest report, which is typically well
    -- before max(expires_at). Kept because it is in the applied contract and
    -- removing a column is a second breaking change for no gain -- but the
    -- mobile side must not render it as "shown until". If nothing consumes it
    -- after the app catches up, drop it in a later pass.
    max(r.expires_at) as expires_at,

    -- The endorse target. The view aggregates the row ids away, so without this
    -- endorse_condition(report uuid) has no reachable input from the client.
    (array_agg(r.id order by r.created_at desc, r.id desc))[1] as latest_report_id
  from public.condition_reports r
  -- THE DISPLAY WINDOW. created_at only -- expires_at is deliberately absent;
  -- see the "two clocks" block above. It is also redundant here: the write path
  -- stamps expires_at = created_at + 30 days and condition_endorsement_extends()
  -- only ever moves it forward (greatest()), so every row inside a 14-day
  -- created_at window necessarily has expires_at in the future. Adding
  -- `and r.expires_at > now()` would filter nothing and would re-tangle the two
  -- clocks for the next reader.
  where r.created_at > now() - interval '14 days'
  group by r.place_id, r.kind
  having count(distinct r.user_id) >= 2;

-- NO user_id AND NO PER-USER DETAIL IN THE OUTPUT, unchanged. The reporters are
-- anonymous to readers, which is also why this view is not block-filtered: there
-- is no author attached to a note or a count and nothing to follow back to a
-- person. It is also what makes the anon grant below safe -- the view contains
-- no auth.uid() anywhere and returns byte-identical rows to every caller.
--
-- ACCEPTED, CARRIED OVER: latest_note can disagree with the distribution. It is
-- the note from the freshest counted report regardless of that report's score,
-- so a group that is 6 poor / 1 good can display the note written by the one
-- 'good'. Scoping the note to the largest bucket was rejected in v1.1 and is
-- rejected again for the same reason: it would break the invariant that
-- latest_note, latest_at and latest_report_id describe the same row, and it
-- would leave latest_at pointing at a different report than the note. This is
-- LESS misleading than it was under v1.1 -- there is no verdict for the note to
-- contradict now, only a distribution the reader can see for themselves. The
-- fix stays presentational: render it as "latest note", attributed to one
-- report.


-- ==================================================== place_condition_flags
-- SIGNATURE:
--
--   place_id   uuid
--   slug       text
--   worst_kind text
--   poor_count int
--   reporters  int
--   latest_at  timestamptz
--
-- ONE ROW PER PLACE worth warning about, so search results and map pins render
-- from one cached fetch for the whole screen instead of a condition lookup per
-- row. `worst_score` is GONE: under the old design it was the constant 'poor'
-- dressed up as data, and there is no verdict column left to source it from.
-- poor_count replaces it and says strictly more -- the client can now render
-- "3 reported poor" instead of a bare warning triangle.
--
-- THE FLAG RULE, and why:
--
--     poor_count >= 2  AND  poor_count >= ok_count  AND  poor_count >= good_count
--
-- `poor_count >= 2` is the substantive half. It is strictly stronger than what
-- v1.1 shipped: v1.1 flagged on the modal verdict, and at the 2-reporter floor a
-- 1-1 tie resolved to 'poor', so ONE person plus any second reporter (even one
-- who said 'good') could put a warning on a course's map pin. That was written
-- down as ACCEPTED-NOT-CLOSED. Requiring two independent accounts to have
-- actually said 'poor' closes it. A lone grudge cannot flag a course, and this
-- is now true of the flag surface in its own right rather than by inheritance
-- from the summary floor.
--
-- THE TIES ARE >=, NOT >, and that is the one place a safety bias survives.
-- 2 poor / 2 ok still flags. The two errors are not equally expensive on a
-- warning surface: failing to warn strands a golfer who drove three hours to a
-- course with punched greens, while over-warning sets expectations low and they
-- have a better round than they feared. What made the v1.1 version of this bias
-- unacceptable was that it operated at n=1; here it only operates once two
-- people have independently reported 'poor', so no single account's opinion is
-- decided by the tie rule. The reader also sees poor_count and reporters and can
-- discount a 2-2 split themselves.
--
-- The rule is a plain comparison of three integers already computed by the
-- summary. There is no rank helper, no mode(), and no ordering of the vocabulary
-- anywhere in this file -- which is why both helpers are dropped below.
--
-- DERIVED FROM condition_summary, NOT FROM condition_reports. Deliberate, and
-- the same choice v1.1 made: the >= 2 reporters floor and the 14-day window are
-- inherited, not restated, so the two surfaces cannot drift. The cost is that
-- this view carries the summary's endorsement subplan even though it never
-- selects `endorsements`; see the cost note after the view.
--
-- slug is included so the client can match against the bundled offline pin data
-- (constraint 2 in CLAUDE.md: course pins are static JSON, not a metered API),
-- and place_id is kept so a caller holding a uuid does not have to round-trip.
create view public.place_condition_flags
with (security_invoker = false) as
  select distinct on (s.place_id)
    s.place_id,
    p.slug,
    s.kind as worst_kind,
    s.poor_count,
    s.reporters,
    s.latest_at
  from public.condition_summary s
  join public.places p on p.id = s.place_id
  where s.poor_count >= 2
    and s.poor_count >= s.ok_count
    and s.poor_count >= s.good_count
  order by s.place_id, s.poor_count desc, s.latest_at desc, s.kind;
-- ORDER BY, read left to right: the DISTINCT ON key; then the kind with the most
-- 'poor' reports, which is what makes `worst_kind` the WORST kind rather than
-- merely the most recent one (v1.1 could only order by recency -- it had no
-- count to rank with); then freshest; then kind alphabetically so the result is
-- deterministic rather than dependent on physical row order. Every sort key is
-- also an output column: DISTINCT ON does permit sort keys that are not, but
-- this file is applied by hand against a database nobody here can test on first,
-- and a parser subtlety is not worth discovering at that moment.
--
-- COST, since the client fetches this view whole and unfiltered:
--   * The aggregation underneath is a full pass over condition_reports with a
--     hash aggregate. Unchanged from v1.1 -- an unfiltered whole-table fetch has
--     always been what this view is.
--   * The endorsement subplan is per SURVIVING GROUP, and surviving groups are
--     those that cleared the >= 2 floor within 14 days -- small by construction,
--     and bounded by the number of rows this view could ever return, not by the
--     size of the table. So even in the worst case it is dominated by the scan
--     it rides along with.
--   * Postgres's remove_unused_subquery_outputs() may well prune the subplan
--     entirely here, since this view selects no `endorsements` column from the
--     non-pulled-up (grouped) subquery. That would make the cost exactly zero.
--     Stated as a likely bonus, NOT relied on -- it has not been EXPLAINed, and
--     the bound in the previous bullet is what makes the view cheap regardless.
--   * If this ever does become the bottleneck, the fix is to build this view
--     directly on condition_reports and restate the floor and window -- paying
--     drift risk for speed. Do not do that speculatively.
--
-- MULTI-NICHE CAVEAT, carried over, real and currently harmless: places.slug is
-- unique per (niche_id, slug), NOT globally. Golf is the only niche today, so a
-- slug identifies a place. The day a second skin ships, either add niche_id here
-- or have the client match on place_id.


-- ============================================================ dead code drop
-- VERIFIED BY GREP OVER EVERY MIGRATION IN supabase/migrations, not assumed:
-- condition_score_rank and condition_score_label appear ONLY in
-- 20260810000001_condition_scores.sql, and within that file only inside the
-- condition_summary body this migration has just replaced (plus prose comments).
-- No other view, function, trigger, policy, CHECK constraint, index expression,
-- generated column or default references either. Grep over apps/, packages/,
-- tooling/, scripts/ and docs/ finds no caller either, so no client is calling
-- them as POST /rpc/condition_score_rank.
--
-- They existed to express one thing -- the worst-to-best ordering of the
-- vocabulary that drove the mode() tie-break. There is no ordering and no
-- tie-break left, so keeping them would leave a live public RPC whose only
-- purpose is a rule the schema no longer implements. The whole mode()
-- tie-break machinery goes with them; it lived inline in the dropped view.
--
-- NOT DROPPED, for the avoidance of doubt: mode() is a Postgres built-in and is
-- still used by place_price_stats in 20260809000001_place_price_bands.sql.
-- Nothing here touches it. Nothing here touches condition_reports.score, its
-- CHECK, report_condition(), condition_reports_sanitize(), endorse_condition()
-- or condition_endorsement_extends() either -- the write path is untouched.
--
-- Argument types are spelled out because DROP FUNCTION needs them to identify
-- the function, and `if exists` keeps the file re-runnable.
drop function if exists public.condition_score_rank(text);
drop function if exists public.condition_score_label(int);


-- =================================================================== grants
-- Supabase's default privileges hand SELECT on new objects to anon and
-- authenticated, so both views are revoked explicitly first and then granted
-- deliberately. Byte-identical to the applied block -- the DROPs above took the
-- old grants with them, and leaving them to Supabase's defaults would be luck
-- rather than intent.
revoke all on public.condition_summary from anon, authenticated;
grant select on public.condition_summary to anon, authenticated;

revoke all on public.place_condition_flags from anon, authenticated;
grant select on public.place_condition_flags to anon, authenticated;
-- ANON READS BOTH, unchanged and re-decided rather than copied. The M8.4 rule:
-- a definer view may be granted to anon only if it does no per-caller filtering.
-- published_trips is authenticated-only BECAUSE its block filter keys off
-- auth.uid() -- with no JWT the anti-join matches nothing and "sign out" becomes
-- a block bypass. Neither view here contains auth.uid() anywhere, in itself or
-- beneath it, exposes no user_id, and returns byte-identical rows to every
-- caller. The new counts do not change this: they are counts of anonymous
-- distinct users, not a per-caller projection. And the map/search screen must
-- render before sign-in -- that is the point of a public catalog.
--
-- BOTH VIEWS ARE security_invoker = false, restated because it is the difference
-- between working and silently empty. condition_reports is revoked from every
-- client role and has no cross-user select policy, so an invoker view over it
-- returns ZERO ROWS TO EVERYONE, forever, and the feature looks "sparse" rather
-- than broken. The endorsement subquery makes this stricter than before: it also
-- reads condition_endorsements, which is likewise revoked from clients and whose
-- only select policy is "read own". An invoker view would now be doubly empty.
-- Definer rights are what let the aggregate see all rows while no client can see
-- any individual one.

-- Re-assert the base-table posture. VERIFIED against the applied file, not
-- assumed: 20260808000001_community.sql lines 643-644 `revoke all on
-- public.condition_reports, public.condition_endorsements from anon,
-- authenticated`; lines 655-656 `grant select, delete ... to authenticated`;
-- lines 664-665 `revoke insert ... from anon, authenticated`. There is no INSERT
-- grant and no UPDATE grant on either table, and neither has an UPDATE policy.
-- So there is no direct PostgREST write path into any number this view
-- publishes: report_condition() and endorse_condition() are the only writers.
--
-- condition_endorsements is re-asserted alongside condition_reports HERE, where
-- 20260810000001 only bothered with reports. That is a direct consequence of
-- this migration: endorsement counts are now a public number, so a forged
-- endorsement is a forged public fact, and the privilege that prevents it
-- deserves to be restated in the file that starts publishing it.
--
-- Both statements are idempotent no-ops against the current state. They exist so
-- the intent survives someone adding a role-level grant later without reading
-- either file, and so this migration's guarantees do not rest on a file it does
-- not contain.
revoke insert, update on public.condition_reports from anon, authenticated;
revoke insert, update on public.condition_endorsements from anon, authenticated;


-- ================================================================== indexes
-- ONE INDEX IS REPLACED, and it is a replacement rather than an addition: net
-- index count on this table is unchanged, so no write is slowed.
--
-- WHY. condition_reports_live_idx (place_id, kind, expires_at) was the right
-- shape for a view that filtered on expires_at. This file filters on created_at.
-- The leading (place_id, kind) still serve `place_id = eq.X` and the grouping --
-- so the old index would not be WRONG, merely carrying a third column that no
-- longer matches any predicate. The new index is the same thing with the third
-- column corrected, so the 14-day window is evaluated inside the index scan for
-- the per-place query rather than as a heap filter afterwards.
--
-- CREATED BEFORE THE OLD ONE IS DROPPED, so no statement boundary in this file
-- leaves the table without a (place_id, kind) index -- and both are inside the
-- transaction, so no concurrent reader sees an intermediate state either.
--
-- NOT CONCURRENTLY, deliberately: CREATE/DROP INDEX CONCURRENTLY cannot run
-- inside a transaction block, and the atomicity requirement at the top of this
-- file outranks the brief lock. condition_reports is small (launch scale, and
-- the table is weeks old), so the ACCESS EXCLUSIVE window is milliseconds.
--
-- NO PREDICATE, so the "IMMUTABLE predicate only" rule is satisfied vacuously.
-- A partial index on the 14-day window is IMPOSSIBLE, not merely undesirable:
-- the predicate would have to call now(), and Postgres requires index predicates
-- to be IMMUTABLE. Same constraint 20260808000001 documented on this table and
-- 20260809000001 restated. Do not try again.
create index if not exists condition_reports_window_idx
  on public.condition_reports (place_id, kind, created_at);

-- SAFE TO DROP, verified rather than assumed: condition_reports_live_idx existed
-- solely to serve condition_summary. The other queries against this table are
-- report_condition()'s ON CONFLICT (driven by condition_reports_one_per_user),
-- endorse_condition() and condition_endorsement_extends() (both by primary key),
-- and the "read own" policy path (user_id leading, also the unique constraint).
-- None of them use it. Reversible in one statement if that turns out wrong.
drop index if exists public.condition_reports_live_idx;

-- WHY NOT WIDEN the new index to cover score and user_id: an index-only scan is
-- unreachable regardless. latest_note, latest_report_id and created_at are all in
-- the projection, so every qualifying row is a heap fetch already; two more
-- columns would slow every write to buy nothing.
--
-- WHY NO INDEX ON condition_endorsements: the endorsement subquery probes it by
-- report_id, which is the leading column of its primary key (report_id, user_id).
-- The NOT EXISTS probes condition_reports by (user_id, place_id, kind), which is
-- exactly condition_reports_one_per_user. Both are covered.
--
-- CASCADE DELETES are already covered: condition_reports_one_per_user leads with
-- user_id, so the delete-account cascade (supabase/functions/delete-account) has
-- an index to drive from.
--
-- WHAT WOULD CHANGE THIS, carried over from 20260810000001 and now slightly more
-- urgent: place_condition_flags aggregates every row in the table with no place
-- filter. Expired rows are never deleted ("they drop out of the view on their
-- own"), so the SCANNED set grows monotonically while the COUNTED set does not --
-- and this migration shrinks the counted set from 30 days to 14, which widens
-- that gap. It is still correct and still cheap while the table is small.
-- Revisit at roughly six figures of rows: the fix is a scheduled delete of rows
-- expired more than N days ago, NOT an index -- no index makes a full
-- aggregation of dead rows cheap, and the dead rows have no reader.


-- =================================================================== closed
-- Adversarial pass. STATIC REVIEW ONLY -- nothing below was executed.
--
-- CLOSED
-- * Can one account inflate poor_count (or any bucket)? NO. condition_reports_
--   one_per_user unique (user_id, place_id, kind) makes one account exactly one
--   row per (place, kind), and every count is count(DISTINCT user_id), so even
--   without the constraint volume buys nothing. Casing does not help: the
--   sanitize trigger lowercases kind BEFORE the ON CONFLICT inference, so
--   'Bunkers' and 'bunkers' collide on the constraint rather than becoming two
--   groups. Re-reporting does not help: report_condition() upserts the caller's
--   OWN row (user_id is part of the constraint and is always auth.uid(), so
--   DEFINER cannot be steered onto a stranger's row) -- a second report replaces
--   the first, moving the account between buckets rather than adding to one.
-- * Can one account publish a group at all? NO. `having count(distinct user_id)
--   >= 2` is unchanged, and place_condition_flags inherits it rather than
--   restating it. Endorsements cannot substitute for the second reporter: they
--   are counted in a separate column that the HAVING does not consult, and the
--   NOT EXISTS makes them disjoint from reporters by construction.
-- * Can one account flag a place? NO, and this is STRONGER than v1.1, which
--   accepted the opposite. poor_count >= 2 requires two independent accounts to
--   have each said 'poor'. The v1.1 hole (1 poor + 1 anything = a 1-1 tie
--   resolved to 'poor' = a flagged map pin) is closed by deleting the tie-break.
-- * Can endorsements be inflated by one account? NO. count(DISTINCT e.user_id)
--   caps a person at one per group no matter how many of the group's reports
--   they endorse; the (report_id, user_id) primary key plus ON CONFLICT DO
--   NOTHING in endorse_condition() caps repeats per report; endorsing your own
--   report raises own_report; and endorsing an expired report raises not_found.
-- * Can counts be forged via a direct PostgREST insert? NO, VERIFIED not
--   assumed: INSERT is revoked from anon and authenticated on condition_reports
--   AND condition_endorsements (20260808000001 lines 664-665, re-asserted
--   above), UPDATE was never granted to either, and neither table has an UPDATE
--   policy. Even if a grant were restored, condition_reports_sanitize()
--   re-validates score on INSERT and UPDATE, and the column CHECK holds under a
--   service-key write with triggers disabled. There is no dynamic SQL anywhere
--   in this file -- every score value is compared as a literal, never
--   interpreted -- so there is no injection surface in the new aggregation.
-- * Endorsement immortality. IMPROVED. Under v1.1, endorsing pushed expires_at
--   forward and therefore kept a report inside the aggregate; a chain of
--   endorsers could hold a stale verdict on screen indefinitely. Counting on
--   created_at severs that: a report leaves the counts 14 days after it was
--   written, endorsements or not. Both surfaces now decay unless people keep
--   actually reporting.
-- * Empty-aggregate trap. Both views are security_invoker = false. As invoker
--   views over the RLS-locked base tables they would return zero rows to every
--   caller forever and look "sparse" rather than broken.
-- * Non-deterministic output. Neither view depends on physical row order: the
--   counts are order-independent, the latest_* trio is fully ordered
--   (created_at desc, id desc), and place_condition_flags' DISTINCT ON is
--   ordered down to an alphabetical last resort. The mode() ORDER BY dependency
--   v1.1 documented is gone entirely -- there is no mode() left in this surface.
-- * Free text in a public number. There is none. The counts are integers over a
--   three-member CHECKed vocabulary; the only free text is `note`, unchanged,
--   still plain_text()'d and 200-char capped in both the RPC and the trigger.
--
-- ACCEPTED, NOT CLOSED
-- * THE DISTRIBUTION LEAKS STRICTLY MORE THAN THE VERDICT DID, at and above the
--   floor. This is the real cost of the change and it should not be soft-pedalled.
--   Under v1.1 at reporters = 2, a published 'poor' told an attacker who knew one
--   reporter's answer that the other said 'poor' or (via the tie-break) possibly
--   not. Under this file the multiset is published outright: "1 poor, 1 good"
--   names both answers, so knowing ONE reporter's identity-and-answer always
--   yields the other's exactly rather than usually. Worse, it does not stop at
--   the floor -- anyone polling the view watches each new reporter's answer
--   arrive as a delta on one of three counters, forever. Someone who posts "just
--   reported the bunkers here" is attributable by anyone who polled before and
--   after.
--   ACCEPTED, for three reasons. (a) The secret recovered is one of three coarse
--   opinions about the state of a golf course's bunkers -- the same calibration
--   the price-band analysis used, and the reason this is not framed as a privacy
--   control. (b) The attacker must ALREADY know who reported and when, and this
--   schema never tells them: condition_reports has no cross-user select policy,
--   no client select grant beyond "read own", condition_endorsements is "read
--   own" too, and neither view carries a user_id or any per-user detail. That
--   knowledge has to come from outside the system. (c) The whole point of the
--   change is that readers see the evidence; a leak-minimising version of this
--   view is the verdict we are deliberately deleting. The real defences remain
--   the >= 2 floor and the owner-only raw tables. This is not differential
--   privacy and must not be described as such.
-- * A user can flip their own vote and move the numbers. Intended: correcting a
--   report is the documented purpose of the upsert, and refusing corrections
--   would strand stale counts with no way to fix them. At the floor a flip moves
--   a whole bucket. No history is kept, so nothing records that an account said
--   'good' on Monday and 'poor' on Tuesday -- the same "current opinion, not a
--   dossier" posture the rest of the schema takes, and it means the counts can
--   move with no audit trail.
-- * A user can DELETE their own report ("condition_reports: delete own" is
--   granted) and drop a group below the floor, hiding it from everyone.
--   Unchanged from v1.1, and the price of letting people retract.
-- * Un-endorse / re-endorse. "condition_endorsements: delete own" is granted, so
--   an account can drop its endorsement and re-add it to roll its created_at
--   forward and stay inside the 14-day endorsement window. This does NOT inflate
--   anything -- the count is DISTINCT on user_id, so the same person re-entering
--   is still one -- it only lets one endorser persist. Bounded by the underlying
--   report's own 14-day window: once the report ages out, no endorsement of it is
--   counted at all. Carried over from 20260808000001's acceptance of the same
--   path against expires_at, where it mattered more than it does here.
-- * Sock puppets. Two accounts controlled by one person clear the floor, and with
--   two 'poor' reports they now also clear the flag rule. Unchanged in kind from
--   v1.1; the flag rule went from "one poor plus any second reporter" to "two
--   poor", so the cost of the attack doubled, but thresholds raise cost and do
--   not make it impossible. content_reports covers the abuse path, the note is
--   still moderatable, and a flag now decays in 14 days rather than 30 with no
--   endorsement lifeline. Revisit if a real incident appears; nothing short of
--   identity verification closes it.
-- * 2-2 splits flag. A course with genuinely divided reports gets a warning pin.
--   Deliberate (see the flag rule), and mitigated by poor_count and reporters
--   both being on the row for the client to render honestly.
-- * latest_note can disagree with the distribution. See the note on the view.
-- * admin_open_content_reports still shows a reported condition report's kind and
--   note but not its score. Unchanged and still deliberately left alone:
--   recreating that view is a change to the moderation runbook's contract, and
--   the score is one service-key SELECT away. Worth folding in next time that
--   view is touched for another reason.

commit;
