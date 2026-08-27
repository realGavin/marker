-- ATOMIC: this migration DROPS report_condition and both condition views before
-- recreating them. Applied by hand, so it must not depend on the client wrapping
-- it -- a failure partway through would otherwise leave production with the RPC
-- and views gone and no way back. Nothing here is transaction-hostile (no
-- CONCURRENTLY, no ALTER TYPE ADD VALUE), so one transaction is safe.
begin;

-- v1.1 Condition SCORES: a report now carries a verdict, not just a label.
--
-- THE PROBLEM. 20260808000001 shipped condition_reports with a `kind` and
-- nothing else, so the public surface said "two people tapped BUNKERS" and
-- stopped there. A golfer reading that cannot tell whether the bunkers are
-- immaculate or unraked cat litter — which is the only thing they wanted to
-- know. Every report must now state good | ok | poor, and condition_summary
-- must publish a VERDICT rather than a headcount.
--
-- Shape follows 20260808000001_community.sql and 20260809000001_place_price_bands.sql
-- exactly, including their three standing lessons:
--
--   1. An RPC is only the sanctioned write path if it is the ONLY write path.
--      INSERT on condition_reports is already revoked from anon/authenticated
--      (verified below, not assumed), and condition_reports_sanitize is extended
--      so the new column's invariants are a property of the TABLE rather than a
--      statement about report_condition().
--   2. Aggregate views are security_invoker = false. The base table is revoked
--      from clients and has no cross-user select policy, so an invoker view
--      would return zero rows to everybody forever.
--   3. A fixed vocabulary is validated STRICTLY (trim + case-fold, then exact
--      membership), never laundered through plain_text(). '<b>poor</b>' is not a
--      score, it is a broken or probing client, and it should be told so. Same
--      call place_price_bands made for `band`.
--
-- WHAT APPLIED STATE THIS ASSUMES. 20260808000001 and 20260808000003 are applied
-- in production and are not edited. 20260809000001 is written but NOT yet
-- applied; nothing here depends on it (no shared object, no shared function), so
-- the two files may be applied in either order.
--
-- BREAKING CHANGE, DELIBERATE AND COORDINATED. The 3-argument
-- report_condition(place, kind, note) is DROPPED, not left alongside the new
-- 4-argument form. PostgREST resolves /rpc/report_condition by the JSON keys in
-- the body; with both overloads present a body carrying place/kind/note matches
-- one and place/kind/score/note matches the other, and any ambiguity there is a
-- 300-class runtime failure rather than a deploy-time error. One function, one
-- signature. apps/mobile/src/lib/data.ts useReportCondition() must ship the
-- `score` key in the same release this migration is applied.
--
-- STATIC REVIEW ONLY. There is no local Postgres on this machine, so nothing in
-- this file has been executed, EXPLAINed, or tested against a live database.
-- Everything below is a static reading of the applied SQL plus the documented
-- behaviour of the constructs used. Gavin applies migrations by hand; treat the
-- first apply as the first execution.

-- =========================================================== condition_reports
-- ------------------------------------------------------------------- score
-- Three members, ordered worst-to-best in the rank helper below. No free text:
-- the CHECK is the immovable backstop, so even a service-key insert with
-- triggers disabled cannot store a fourth value, and there is nothing here to
-- moderate.
--
-- BACKFILL = 'poor', and that is a judgement call rather than a neutral default.
-- The old chip carried an implied verdict: nobody taps "BUNKERS" to say the
-- bunkers are lovely, they tap it because something is off. Mapping the legacy
-- rows to 'good' would silently rewrite those reports into the opposite of what
-- their authors meant; mapping them to 'ok' invents a middle position none of
-- them took. 'poor' is the honest reading. Production has no real reports yet,
-- so in practice this backfills nothing — it is written to be correct on any
-- database this file is ever applied to, including a restored snapshot.
alter table public.condition_reports
  add column if not exists score text not null default 'poor'
    check (score in ('good', 'ok', 'poor'));

-- ...and then the default goes away. A DEFAULT here would mean a future writer
-- that forgets `score` silently publishes 'poor' about a real golf course, which
-- is the single most damaging value in the vocabulary to assign by accident. Two
-- statements, not one, precisely so the backfill and the ongoing rule can differ:
-- the backfill needs a value, every future write must state one.
alter table public.condition_reports alter column score drop default;

-- ============================================================== pure helper
-- Ranks a score worst-first: poor = 1, ok = 2, good = 3. This ordering IS the
-- tie-break rule — condition_summary takes the mode over the rank rather than
-- over the score precisely so that "ties resolve toward the worse score" is a
-- consequence of the sort order rather than a special case bolted on afterwards.
--
-- STAYS IN public, and that is a decision, not an oversight — same rule
-- 20260808000001 applied to plain_text() and the itinerary counters. It is an
-- IMMUTABLE function of its argument alone, reads no table, and holds no secret:
-- being callable as POST /rpc/condition_score_rank tells an attacker nothing
-- they could not work out by reading this file. The rule is "helpers that TOUCH
-- ROWS go to private", and this touches none.
--
-- WHY A FUNCTION rather than an inline CASE: the ordering is the entire content
-- of the tie-break rule, and it is referenced from two views. Naming it means
-- there is exactly one place to edit if the vocabulary ever widens.
--
-- Nulls are impossible (the column is NOT NULL) but an unknown value returning
-- null would sort LAST under the default ASC NULLS LAST, i.e. it could never win
-- a tie by accident. Failing safe, not failing loud, is right for an ordering
-- helper: a view is not the place to raise.
create or replace function public.condition_score_rank(score text)
returns int language sql immutable as $$
  select case score when 'poor' then 1 when 'ok' then 2 when 'good' then 3 end
$$;

-- The inverse. condition_summary takes the mode of the RANK (so that the
-- tie-break is expressed in the ordering) and has to turn the winning rank back
-- into the text the client renders. Kept as a function rather than an inline
-- CASE for the same reason as its partner: the two of them are the only place in
-- the schema that knows how the vocabulary is ordered, and they have to be
-- edited together or not at all.
-- Parameter is score_rank, not rank: RANK is an ordered-set aggregate name in
-- Postgres, and while a bare `rank` parses as an identifier here, a one-word
-- rename costs nothing and removes the only place in this file where a reader
-- has to know that.
create or replace function public.condition_score_label(score_rank int)
returns text language sql immutable as $$
  select case score_rank when 1 then 'poor' when 2 then 'ok' when 3 then 'good' end
$$;

-- ========================================================= write-path trigger
-- Belt and braces behind the revoked INSERT privilege. Identical to the applied
-- 20260808000001 body in every respect EXCEPT the score block; kind, note,
-- created_at and expires_at handling are carried over character-for-character so
-- this replacement cannot quietly relax an existing invariant.
--
-- The score block is placed with the other normalisation and BEFORE the tg_op
-- branch, so it runs on UPDATE as well as INSERT. That matters: the only UPDATE
-- paths are report_condition()'s ON CONFLICT refresh and
-- condition_endorsement_extends(), and the first of those writes a new score.
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

  -- Trim and case-fold ONLY, then an exact membership test — deliberately not
  -- plain_text(). That helper exists to make free text safe to DISPLAY, and
  -- cleaning input into validity is the wrong instinct for a three-member enum.
  -- Raising 'invalid_score' here rather than letting the column CHECK fire is
  -- what makes the failure a code the client can switch on instead of a raw
  -- 23514 with a constraint name in it.
  new.score := lower(btrim(coalesce(new.score, '')));
  if new.score not in ('good', 'ok', 'poor') then raise exception 'invalid_score'; end if;

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
-- The trigger itself (condition_reports_sanitized, BEFORE INSERT OR UPDATE) is
-- unchanged and is NOT recreated: CREATE OR REPLACE FUNCTION rebinds the
-- existing trigger to the new body. Recreating the trigger would drop and
-- re-add it, which is a window — however short — in which an insert lands
-- unsanitised.
--
-- CONFIRMED against the new shape: condition_endorsement_extends() UPDATEs only
-- expires_at, so NEW.score is the row's existing, already-validated value. It
-- round-trips through lower(btrim(...)) unchanged and passes the membership
-- test, so endorsement renewal still works and still cannot alter a verdict. An
-- endorsement remains "still true" about someone else's report — it renews the
-- row's life, it does not add a reporter and it does not vote. That is now a
-- stronger statement than it was: with a score attached, "I saw this too" means
-- "I agree with this verdict", and the mobile copy should say so.

-- =================================================================== RPC
-- Error codes the mobile client switches on, restated in full so this file is
-- readable alone. Existing (20260808000001 / 20260808000003):
--
--   not_signed_in | not_owner | not_found | own_report | own_trip |
--   cannot_block_self | note_too_long | invalid_kind | invalid_title |
--   invalid_target | too_many_reports | content_suspended
--
-- Plus invalid_band, added by 20260809000001 (written, not yet applied).
--
-- NEW IN THIS MIGRATION: invalid_score. Raised by report_condition() and by
-- condition_reports_sanitize() for any value that is not good | ok | poor after
-- trimming and case-folding, including null and empty string.

-- ------------------------------------------------------- report_condition
-- DROP FIRST. Postgres treats (uuid, text, text) and (uuid, text, text, text) as
-- two distinct functions, so CREATE OR REPLACE on the 4-argument form would
-- ADD an overload and leave the 3-argument one live — the exact ambiguous-RPC
-- failure described in the header. `if exists` keeps the file re-runnable.
drop function if exists public.report_condition(uuid, text, text);

-- Every existing guard is carried over unchanged: not_signed_in, the suspension
-- check, kind normalisation, note sanitize-then-measure, place existence, and
-- the ON CONFLICT ON CONSTRAINT upsert that lets a user CORRECT their own report
-- instead of stacking a second one. The only additions are the `score` parameter
-- and its validation.
--
-- NO RATE CAP, checked rather than assumed: 20260808000003 added the
-- report_attempts ledger to report_content() ONLY. The applied report_condition()
-- has never had one, and this migration does not invent one — the axis that
-- matters here is already capped by condition_reports_one_per_user (one account,
-- one live row per place+kind, so volume buys no extra weight in the aggregate),
-- and the resource report_content() was defending — a human moderation queue
-- under a 24h SLA — has no analogue on this path. Same reasoning, at length, as
-- the "rate cap: NOT ADDED" section of 20260809000001.
--
-- PARAMETER ORDER is (place, kind, score, note) — score before the optional note,
-- so the required arguments are contiguous. PostgREST matches on JSON KEY NAMES,
-- not position, so this is a readability choice and not a wire concern.
create or replace function public.report_condition(place uuid, kind text, score text, note text)
returns uuid language plpgsql security definer
set search_path = public, private, pg_temp as $$
declare
  v_kind  text;
  v_score text;
  v_note  text;
  v_id    uuid;
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

  -- Normalise the same way kind is (case-fold + trim), then reject STRICTLY.
  -- Not plain_text(): see the trigger. A null or empty score lands here as ''
  -- and raises, which is what enforces "every future write states a score"
  -- alongside the dropped column default.
  v_score := lower(btrim(coalesce(score, '')));
  if v_score not in ('good', 'ok', 'poor') then raise exception 'invalid_score'; end if;

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
  --
  -- ON CONFLICT ON CONSTRAINT, not ON CONFLICT (user_id, place_id, kind): the
  -- parameters `kind`, `score` and `note` are all column names too, and plpgsql's
  -- default variable_conflict = error turns a bare column reference in an
  -- inference clause into a runtime "ambiguous" failure. The named constraint has
  -- no such collision. (The column names on the LEFT of a SET are assignment
  -- targets, not expressions, so `set score = excluded.score` is unambiguous —
  -- the applied version already relies on exactly this for `note`.)
  insert into public.condition_reports (user_id, place_id, kind, score, note)
  values (auth.uid(), place, v_kind, v_score, v_note)
  on conflict on constraint condition_reports_one_per_user do update
    set score      = excluded.score,
        note       = excluded.note,
        created_at = now(),
        expires_at = now() + interval '30 days'
  returning id into v_id;

  return v_id;
end $$;
-- EXECUTE on functions is granted to PUBLIC by default, which is what we want:
-- the function opens with its own auth.uid() check, so an anon call gets
-- not_signed_in and nothing else.

-- ================================================================== views
-- Both are security_invoker = false, for the reason at the top of this file and
-- of 20260808000001: condition_reports is revoked from every client role and has
-- no cross-user select policy, so an invoker view over it is permanently empty.
--
-- Dropped and recreated rather than CREATE OR REPLACE'd: a replacement may only
-- APPEND columns, and `score` belongs next to `kind` where a reader will find it
-- rather than tacked on the end. Flags is dropped first because it depends on
-- summary; both drops are `if exists` so the file re-runs cleanly.
drop view if exists public.place_condition_flags;
drop view if exists public.condition_summary;

-- --------------------------------------------------------- condition_summary
-- Two independent reporters before a condition is public, and expired rows drop
-- out on their own — no cleanup job, no moderation queue. Both of those rules are
-- unchanged; what changed is that the row now carries a VERDICT.
--
-- TIE-BREAK: THE MODE RESOLVES TOWARD THE WORSE SCORE (poor > ok > good).
-- This is asymmetric on purpose. The two errors are not equally expensive: under-
-- reporting a hazard strands a golfer who drove three hours to a course whose
-- greens are punched, while over-reporting merely sets expectations low and they
-- have a better round than they feared. When the reports genuinely disagree we
-- have no way to know who is right, so we pay the cheaper error.
--
-- HOW THE TIE-BREAK IS EXPRESSED: mode() over the RANK, not over the score.
-- mode() within group (order by X) returns the most frequent X, resolving ties
-- to the first value in the given sort order. Ordering by condition_score_rank()
-- ascending puts poor(1) ahead of ok(2) ahead of good(3), so an equal split
-- resolves to the WORSE score, which is the rule stated above. The winning rank
-- is mapped back to text by condition_score_label().
--
-- A STRUCTURAL FORM WAS WRITTEN FIRST AND REJECTED, and the reason is worth
-- recording. Computing per-score counts in one CTE and the group aggregate in
-- another states the rule more explicitly in the query text, but it references
-- the "live rows" CTE twice — and since PG12 a CTE referenced more than once is
-- MATERIALIZED, which blocks qualifier pushdown. `condition_summary?place_id=eq.X`
-- (apps/mobile useConditions, i.e. every place page) would then aggregate every
-- live report in the table into a tuplestore before filtering, and
-- condition_reports_live_idx would go unused. The single-level form below keeps
-- the place_id filter pushed down to the index scan exactly as the applied view
-- did. Clarity of one comment is not worth the hot path.
--
-- WHAT THIS FORM RESTS ON, stated so it can be checked rather than assumed:
--   1. mode()'s tie resolution follows the ORDER BY. The docs hedge it as
--      "arbitrarily choosing the first one"; the implementation keeps the first
--      maximal run of the sorted input, which is deterministic given the sort.
--      place_price_stats (20260809000001) already relies on the same behaviour
--      and documents it, so this file introduces no new dependency.
--   2. mode() counts ROWS, while the gate counts DISTINCT USERS. Those are equal
--      only because condition_reports_one_per_user makes one account exactly one
--      row per (place, kind). That constraint is therefore load-bearing for the
--      VERDICT now, not just for the headcount: relax it and one account could
--      outvote the group. Same coupling place_price_stats has.
create view public.condition_summary
with (security_invoker = false) as
  select
    place_id,
    kind,
    public.condition_score_label(
      mode() within group (order by public.condition_score_rank(score))
    ) as score,
    count(distinct user_id)::int as reporters,
    (array_agg(note order by created_at desc, id desc))[1] as latest_note,
    max(created_at) as latest_at,
    max(expires_at) as expires_at,
    (array_agg(id order by created_at desc, id desc))[1] as latest_report_id
  from public.condition_reports
  where expires_at > now()
  group by place_id, kind
  having count(distinct user_id) >= 2;
-- Everything except the `score` expression is character-identical to the applied
-- view, deliberately: the gate, the expiry filter, the latest_* tie-breaks and
-- the output names all keep their exact behaviour, so the only thing a reviewer
-- has to reason about is the one new column.
--
-- count(DISTINCT user_id), not count(*), in BOTH the output and the gate — they
-- have to be the same expression, or the displayed number would be advertising a
-- consensus the gate never checked. Carried over unchanged.
--
-- No user_id in the output: the reporters are anonymous to readers, which is also
-- why this view is not block-filtered — there is no author to attribute a note or
-- a verdict to and nothing to follow back to a person.
--
-- latest_report_id is retained unchanged. It is the endorse target: the view
-- aggregates away the row ids, so without it endorse_condition(report uuid) has
-- no reachable input. It remains the id of the same row latest_note/latest_at
-- come from, which is the invariant apps/mobile/src/lib/data.ts documents.
--
-- ACCEPTED: latest_note can disagree with `score`. latest_note is the note from
-- the freshest live report REGARDLESS of that report's score, so a group whose
-- verdict is 'poor' can display a note written by the one reporter who said
-- 'good'. Scoping the note to reports matching the verdict was considered and
-- rejected: it would break the documented invariant that latest_note, latest_at
-- and latest_report_id all describe the SAME row, and it would leave latest_at
-- (which must be the group's true freshness) pointing at a different report than
-- the note. The mobile fix is presentational — render the note as "latest note",
-- attributed to one report, not as the explanation of the verdict.

-- ---------------------------------------------------- place_condition_flags
-- ONE ROW PER PLACE that currently has an active 'poor' verdict, so search
-- results and map pins can show a condition warning with a single query for the
-- whole screen. The pattern this exists to prevent is a condition lookup per
-- rendered row, which a prior performance audit already killed once (the same
-- audit that added place_logs_place_rating_idx).
--
-- Small by construction: a place appears only if at least two independent
-- accounts filed 'poor' about the same kind within the last 30 days. At launch
-- scale the client can fetch the entire view once and keep it in memory.
--
-- DERIVED FROM condition_summary, not from condition_reports. That is the whole
-- point of the shape: the >= 2 distinct reporters floor and the 30-day expiry are
-- not restated here, they are inherited, so the two surfaces can never drift into
-- disagreeing about what is "active".
--
-- slug is included so the client can match against the bundled offline pin data
-- (constraint 2 in CLAUDE.md: course pins are static JSON, not a metered API), and
-- place_id is kept so a caller holding a uuid does not have to round-trip.
create view public.place_condition_flags
with (security_invoker = false) as
  select distinct on (s.place_id)
    s.place_id,
    p.slug,
    s.kind      as worst_kind,
    s.score     as worst_score,
    s.reporters,
    s.latest_at
  from public.condition_summary s
  join public.places p on p.id = s.place_id
  where s.score = 'poor'
  order by s.place_id, s.latest_at desc, s.kind;
-- ORDER BY, read left to right: the DISTINCT ON key, then the most recently
-- reported of this place's poor kinds, then kind alphabetically so the choice is
-- deterministic rather than dependent on physical row order. Every sort key is
-- also an output column — DISTINCT ON does permit sort keys that are not, but
-- this migration is applied by hand against a database nobody here can test on
-- first, and a parser subtlety is not worth discovering at that moment.
--
-- No score term in the ORDER BY: the WHERE already pins every candidate row to
-- 'poor', so ranking them against each other would be a no-op dressed up as
-- forward-compatibility. If a score worse than 'poor' is ever added, BOTH the
-- WHERE and this ORDER BY need editing — see the maintenance note below, which
-- is the honest version of that promise.
--
-- worst_score is therefore the constant 'poor' today. It is still a column
-- rather than an implied constant so the client's rendering does not have to
-- change when the vocabulary widens, and so a reader of the JSON can see what
-- the flag means without consulting this file.
--
-- MAINTENANCE NOTE — a new score value touches exactly six places, all of them
-- in this file: the CHECK on condition_reports.score, the membership test in
-- report_condition(), the membership test in condition_reports_sanitize(),
-- condition_score_rank(), its inverse condition_score_label(), and the
-- `s.score = 'poor'` predicate above (plus this view's ORDER BY, if the new
-- value is worse than 'poor'). Nothing else enumerates the vocabulary —
-- condition_summary names no score literal at all, it goes rank -> mode ->
-- label, so widening the pair of helpers is what widens the verdict.
--
-- MULTI-NICHE CAVEAT, real and currently harmless: places.slug is unique per
-- (niche_id, slug), NOT globally. Golf is the only niche today, so a slug
-- identifies a place. The day a second skin ships, either add niche_id to this
-- view or have the client match on place_id — matching on a bare slug across two
-- niches would flag the wrong pin.

-- ================================================================== grants
-- Supabase's default privileges hand SELECT on new objects to anon and
-- authenticated, so both views are revoked explicitly first and then granted
-- deliberately. The base table's posture is re-asserted at the bottom.
revoke all on public.condition_summary from anon, authenticated;
grant select on public.condition_summary to anon, authenticated;
-- Unchanged from 20260808000001; restated because the DROP took the old grants
-- with it and leaving them to Supabase's defaults would be luck, not intent.

revoke all on public.place_condition_flags from anon, authenticated;
grant select on public.place_condition_flags to anon, authenticated;
-- ANON READS THIS, deliberately, and the decision was made rather than copied.
--
-- The rule the M8.4 review settled on: a definer view may be granted to anon only
-- if it does no per-caller filtering. published_trips is authenticated-only
-- BECAUSE its block filter keys off auth.uid() — with no JWT the anti-join
-- matches nothing, every block silently evaporates, and "sign out" becomes a
-- block bypass. This view contains no auth.uid() anywhere, in itself or in
-- condition_summary beneath it, exposes no user_id, and returns byte-identical
-- rows to every caller. Signing out gains an attacker exactly nothing.
--
-- Stronger still: this view is a pure REPROJECTION of two surfaces anon can
-- already read — condition_summary (granted to anon since 20260808000001) and
-- places.slug (public catalog, "places: public read" using (true)). Withholding
-- it from anon would hide no fact; it would only force an unauthenticated client
-- to reconstruct the same rows with more queries, which is the performance
-- pattern the view exists to remove. And a search/map screen must render before
-- sign-in — that is the point of having a public catalog at all.

-- Re-assert the base table posture. VERIFIED, not assumed: 20260808000001 lines
-- 643 / 655 / 664 do `revoke all on public.condition_reports from anon,
-- authenticated`, then `grant select, delete ... to authenticated`, then an
-- explicit `revoke insert on public.condition_reports from anon, authenticated`.
-- There is no INSERT grant and no UPDATE grant, and no UPDATE policy exists on
-- the table at all. So there is no direct PostgREST write path for `score`:
-- report_condition() is the only writer, which is what makes its validation
-- enforceable rather than cosmetic.
--
-- The statements below are idempotent no-ops against that state. They exist so
-- the intent survives someone adding a role-level grant later without reading
-- either file, and so this migration's guarantees do not depend on a file it
-- does not contain.
revoke insert, update on public.condition_reports from anon, authenticated;

-- =================================================================== indexes
-- NOTHING NEW IS NEEDED, and that is a conclusion rather than an omission.
--
-- condition_reports_live_idx (place_id, kind, expires_at) STILL SERVES the
-- rewritten view. The group keys are unchanged — (place_id, kind) — so it is
-- still the index that turns "conditions for this place" into an index scan
-- instead of a sequential scan of every report ever filed, and place_id leading
-- is what both `place_id = eq` and `place_id = any(...)` need. The new `score`
-- column changes the projection, not the grouping.
--
-- That conclusion is CONDITIONAL on the view staying single-level, which is why
-- the CTE form was rejected above: a materialized CTE would have put a tuplestore
-- between the place_id filter and this index, and the index would have gone
-- unused on the one query that runs on every place page. The two decisions are
-- the same decision.
--
-- WHY NOT WIDEN IT to cover score and user_id: an index-only scan is unreachable
-- here no matter how wide the index gets. latest_note, latest_report_id and
-- created_at are all in the output, so every qualifying row is a heap fetch
-- already; adding two more columns would slow every write to buy nothing. This
-- was already true before this migration (note/created_at/id were already in the
-- projection) — the score column does not change the answer.
--
-- WHY NO PARTIAL INDEX on live rows: the predicate would need now(), and Postgres
-- requires index predicates to be IMMUTABLE. Same constraint 20260808000001
-- documented on this table and 20260809000001 restated. The brief's "immutable
-- predicates only" is satisfied vacuously — there are no new predicates.
--
-- CASCADE DELETES are already covered: condition_reports_one_per_user is a unique
-- constraint on (user_id, place_id, kind) with user_id LEADING, so the
-- delete-account cascade (supabase/functions/delete-account, a one-tap action)
-- has an index to drive from. No user_id-only index is needed.
--
-- WHAT WOULD CHANGE THIS. place_condition_flags, fetched whole, aggregates EVERY
-- live report in the table with no place filter — a full scan plus a hash
-- aggregate, which is correct and cheap at launch scale and stays cheap while the
-- table is small. But expired rows are never deleted (the design is "they drop
-- out of the view on their own"), so the scanned set grows monotonically while
-- the LIVE set does not. Revisit when condition_reports passes roughly six
-- figures of rows: the fix is a scheduled delete of rows expired more than N days
-- ago, NOT an index — no index can make a full aggregation of dead rows cheap,
-- and the dead rows have no reader. Nothing in this migration makes that day
-- arrive sooner.

-- ================================================================== closed
-- The adversarial pass over this migration. Static review only — see the header.
--
-- CLOSED
-- * Can one account publish a verdict alone? NO. condition_summary keeps
--   `having count(distinct user_id) >= 2`, and condition_reports_one_per_user
--   makes one account exactly one live row per (place, kind), so a single
--   account cannot become two reporters by volume, by casing (the trigger
--   lowercases kind BEFORE the ON CONFLICT inference), or by re-reporting (the
--   upsert replaces its own row). Endorsements do not help either: an endorser
--   renews a report's clock but is never counted in count(distinct user_id), so
--   one reporter plus a hundred endorsers is still invisible. place_condition_flags
--   inherits the floor rather than restating it, so it cannot be flagged by one
--   account either. This is the whole defence against one grudge tanking a
--   course and it is intact.
-- * Can a lone account KEEP a verdict published? NO. Re-reporting refreshes only
--   the caller's own row; the second reporter's row still expires 30 days after
--   their last report or endorsement, and the group falls below the floor and
--   disappears the moment it does.
-- * Score injection or bypass via direct PostgREST insert. VERIFIED, not assumed:
--   INSERT is revoked from anon and authenticated on condition_reports (twice,
--   in 20260808000001, and re-asserted above), UPDATE was never granted, and
--   there is no UPDATE policy. Even if a grant were restored,
--   condition_reports_sanitize re-validates score on INSERT and UPDATE, and the
--   column CHECK holds under a service-key write with triggers disabled. Three
--   independent layers, and no dynamic SQL anywhere in this file — the score
--   string is compared, never interpreted, so there is no injection surface at
--   all.
-- * Free text in a public verdict. There is none. score is one of three literals;
--   the only free text remains `note`, which is unchanged and still goes through
--   plain_text() plus a 200-char cap in both the RPC and the trigger.
-- * Ambiguous RPC overload. The 3-argument report_condition is DROPPED in this
--   file, not shadowed. PostgREST cannot resolve two functions that differ only
--   by an optional-looking key, and that failure appears at runtime rather than
--   at deploy.
-- * DEFINER steered into writing someone else's row. user_id is always
--   auth.uid() and is part of the unique constraint, so the ON CONFLICT target
--   is provably the caller's own row. Unchanged, restated because the upsert now
--   overwrites a verdict as well as a note.
-- * Empty-aggregate trap. Both views are security_invoker = false; as invoker
--   views over this RLS-locked table they would return zero rows to every caller
--   forever, and the feature would look "sparse" rather than broken.
-- * Non-deterministic verdict. Neither view depends on physical row order:
--   condition_summary's tie-break is the mode's ORDER BY, and
--   place_condition_flags' choice of kind is fully ordered down to an
--   alphabetical last resort. See the view comments for the one behaviour this
--   DOES rest on (mode()'s tie resolution) and why it is not a new dependency.
--
-- ACCEPTED, NOT CLOSED
-- * ONE DISSENTER OF TWO SETS THE VERDICT. At exactly the floor, one 'poor' and
--   one 'good' is a 1-1 tie, and the tie-break publishes 'poor'. So a single
--   account CAN move a place into place_condition_flags — provided one other
--   independent account reported the same kind at all, whatever they said. This
--   is the direct cost of the safety bias and it is accepted knowingly: the
--   alternative (require a plurality, publish nothing on a tie) means a place
--   with genuinely disputed conditions shows a golfer nothing, which is the
--   expensive error. It is bounded — the dissenter cannot manufacture the second
--   reporter, cannot report twice, and the flag ages out in 30 days — and the
--   honest mitigation is presentational: the mobile side should show `reporters`
--   next to the verdict so "2 reporters, poor" reads as thin evidence rather
--   than as a fact.
-- * A user can flip their own vote and move the published verdict. Intended:
--   correcting a report is the documented purpose of the upsert, and refusing
--   corrections would leave stale verdicts on screen with no way to fix them.
--   At the 2-reporter floor a flip changes the verdict; above it, it is one vote
--   among many. No history is kept, so nothing records that an account said
--   'good' on Monday and 'poor' on Tuesday — the same "current opinion, not a
--   dossier" posture place_price_bands took, and it means the verdict can move
--   with no audit trail.
-- * MODE LEAKS AT THE 2-REPORTER BOUNDARY. It does, and pretending otherwise
--   would repeat the mistake the place_rating_stats comment was rewritten to
--   fix. At exactly reporters = 2: if an attacker knows ONE reporter's answer,
--   the published verdict usually names the other's — a published 'good' means
--   both said 'good' (a tie or any 'poor' would have resolved worse), and a
--   published 'poor' with a known 'good' means the other said 'poor'. Watching
--   `reporters` tick from 2 to 3 while the verdict moves narrows the newcomer
--   similarly. What keeps this from mattering is unchanged from the price-band
--   analysis: the attacker must already know WHO reported and WHAT they said,
--   and this schema never tells them — condition_reports has no cross-user
--   select policy, no client select grant beyond "read own", and neither view
--   carries a user_id, so that knowledge must come from outside the system. The
--   recovered secret is one of three coarse opinions about the state of a golf
--   course's bunkers. The real defences are the floor and the owner-only raw
--   table; this is not differential privacy and should not be described as such.
-- * Sock puppets. Two accounts controlled by one person clear the floor and set
--   any verdict they like, now including a public 'poor' flag on a course's map
--   pin — which is a reputational surface the pre-score version did not have.
--   The same limit decision 0001 accepted for price bands and 20260808000001
--   accepted for votes and endorsements: thresholds raise the cost, they do not
--   make it impossible. content_reports covers the abuse path, the note is still
--   moderatable, and a flag expires in 30 days on its own. Revisit if a real
--   incident appears; nothing short of identity verification closes it.
-- * latest_note can disagree with the verdict. See the note on the view.
-- * admin_open_content_reports still shows a reported condition report's kind and
--   note but NOT its score, so a moderator reading the queue sees "bunkers /
--   'unraked for weeks'" without the verdict attached. Deliberately left alone:
--   recreating that view is a change to the moderation runbook's contract for a
--   marginal gain, and the score is one service-key SELECT away. Worth folding in
--   the next time that view is touched for another reason.

commit;
