-- ATOMIC: this migration adds six columns to a live table (one of them a stored
-- generated column, so the table is rewritten), backfills one of them, installs
-- a guard trigger, rewrites the client privilege grants on public.trip_plans,
-- and creates public.plan_turns. It is applied by hand, so it must not depend
-- on the client wrapping it. A failure partway through would otherwise be worse
-- than not shipping: the dangerous half-state is "columns exist, grants not yet
-- tightened", i.e. candidate_ids and refinements_used present and writable by
-- every authenticated client -- which is the exact hole this file exists to
-- close. Nothing below is transaction-hostile (no CREATE INDEX CONCURRENTLY, no
-- ALTER TYPE ADD VALUE, no VACUUM); the revision_count rewrite is ordinary
-- transactional DDL, it just takes a stronger lock for longer than the other
-- adds. One transaction is safe.
--
-- RE-RUNNABLE, but note WHY -- ONE statement is not self-guarding:
--   * `create trigger trip_plans_conversation_guard` is bare, because Postgres
--     has no `create trigger if not exists`. It is safe only because the
--     matching `drop trigger if exists ... on public.trip_plans` runs
--     immediately before it. Do not reorder the drop below the create on the
--     assumption that every statement guards itself.
-- Everything else guards itself:
--   * `alter table ... add column if not exists` -- and note that when the
--     column already exists the ENTIRE subcommand is skipped, inline CHECK
--     included, so the constraints below are added exactly once and a second
--     run does not attempt a duplicate `add constraint` (which is the usual
--     re-runnability trap with column checks).
--   * the brief backfill is filtered `where brief = '{}'::jsonb`, so a second
--     run matches zero rows and, critically, a retry can never overwrite a
--     brief a user has since edited.
--   * the plan_turns backfill is filtered `not exists (... trip_id = tp.id and
--     kind = 'create')`, so a second run -- or a re-run after a partial failure
--     -- inserts nothing and cannot double-charge anybody.
--   * `create or replace function`, `revoke`, and `grant` are all idempotent.
--   * `create table if not exists` / `create index if not exists` for
--     plan_turns -- and note the same whole-subcommand skip applies: a second
--     run does not re-add its CHECK or its foreign keys.
--   * `alter table ... enable row level security` is idempotent.
--
-- STATIC REVIEW ONLY, WITH ONE NARROW EXCEPTION. There is no local Postgres on
-- this machine. No statement in this file has been executed, EXPLAINed, or
-- tested against a live database; everything below -- including the adversarial
-- pass at the bottom -- is a static reading of this file plus the
-- already-applied migrations it depends on, plus the documented behaviour of
-- the constructs used. Gavin applies migrations by hand: treat the first apply
-- as the first execution.
-- THE EXCEPTION, so the claim above stays honest: the shape of existing
-- `trip_plans.request` payloads was checked with a READ-ONLY query against
-- production while choosing the plan_turns backfill predicate -- that is where
-- "production holds such a row with stops=3" comes from. Data was read; nothing
-- was written and no DDL here was run.
--
-- DEPENDS ON (all applied, none edited here):
--   20260724000001_core_schema.sql       -- public.trip_plans, its RLS, request/itinerary
--   20260727000002_trip_planner.sql      -- places_near(), the retrieval this grounds on
--   20260728000002_trip_collab.sql       -- trip_members, "trip_plans: update own or member"
--   20260729000001_trip_collab_hardening -- public.trip_plans_guard_immutable / trip_plans_immutable
--   20260808000001_community.sql         -- schema `private`, private.is_service_role(),
--                                           trip_plans_guard_publish, the grant/revoke posture
--
-- DOES NOT TOUCH: supabase/functions/ (the ai-engineer owns plan-trip in
-- parallel), apps/, tooling/. This file is schema only.
begin;

-- ============================================================================
-- CONVERSATIONAL TRIP REFINEMENT.
--
-- THE FEATURE. The trip planner is the paid feature and today it is one-shot:
-- fill a form, get an itinerary, and the only way to change anything is to
-- regenerate from scratch, which burns one of 20 monthly plans. We are making
-- it iterative -- the user says "swap day 2 for something shorter, we have a
-- flight" and the itinerary is revised in place.
--
-- WHAT THAT COSTS THE SCHEMA. An iterative feature needs three pieces of state
-- a one-shot feature did not:
--   * what the plan was asked for      -> brief
--   * what the plan may choose from    -> candidate_ids
--   * how many turns have been spent   -> refinements_used
-- plus revisions, so a turn can be undone, and version, so two writers racing
-- on the same row cannot silently overwrite each other (see its own comment).
--
-- TWO OF THOSE ARE SECURITY STATE, NOT USER DATA, and that is the whole
-- design problem this file solves:
--
--   candidate_ids is the GROUNDING ANCHOR. plan-trip's no-invented-courses
--   guarantee is not a prompt instruction, it is an architecture: the SERVER
--   retrieves real places -- places_near, bounded only by the max_results its
--   caller passes, since the function itself has no clamp -- and the model may
--   only arrange what it was handed. A refinement that re-ran retrieval every
--   turn would be slow and would let the candidate set drift; so it is frozen
--   on the row and reused. Which means: whoever can write candidate_ids can
--   write the model's entire universe of allowed answers. A client that could
--   PATCH it could put any uuid in there -- including uuids that are not in
--   public.places at all -- and the "we only ever recommend real, vetted
--   places" property becomes a property of the attacker's request body.
--
--   refinements_used is QUOTA. It is the meter on a metered feature whose unit
--   cost is an LLM call we pay for. A client that can PATCH it to 0 has
--   unlimited turns; that is not a privilege-escalation curiosity, it is a
--   direct, repeatable charge on our inference bill.
--
-- Neither is data the user authored. Both are the server's own bookkeeping that
-- happens to be stored on a row the user can otherwise edit. So both are
-- SERVICE-ROLE-WRITE-ONLY, fenced twice (privilege + trigger), on the INSERT
-- path as well as the UPDATE path.
--
-- THREAT MODEL, carried forward. 20260729000001 shipped after a review found
-- that a trip MEMBER could seize ownership: RLS `WITH CHECK` is evaluated
-- against the NEW row only, so "update own or member" let a member set
-- user_id = auth.uid() and watch the new row satisfy the check. The general
-- lesson, which every column added to this table since has had to respect:
--
--   * RLS can never compare OLD to NEW, so any rule of the form "this column
--     may not change" or "only the owner may change this" is UNEXPRESSIBLE in
--     RLS and must live in a BEFORE row trigger.
--   * RLS has no column granularity at all, so "who may write WHICH column" is
--     a GRANT question, not a policy question (20260808000001 learned this on
--     profiles.content_suspended_at, where an owner-scoped "update own" policy
--     happily accepted PATCH {"content_suspended_at": null}).
--   * "The client does not send that field" is not a control. PostgREST is a
--     generic table endpoint; every column is one curl away.
-- ============================================================================

-- ================================================================== columns
--
-- All five are NOT NULL with defaults, so every existing row is valid the
-- instant the column appears and no code path has to handle a null.
-- (revision_count, added by the separate statement below, is NOT NULL too but
-- needs no default: it is generated, so its value is always derivable.) The CHECK
-- constraints are inline on ADD COLUMN, which means (a) they are added exactly
-- once and the file stays re-runnable, and (b) they bind EVERY writer including
-- the service role and a psql session -- these are the invariants that hold
-- even when the edge function has a bug.

alter table public.trip_plans
  -- The structured inputs the plan was generated from: region, dates, days,
  -- rounds, style tags, max hop distance, wishlist / avoid-played flags,
  -- free-text notes. Stored so (1) a refinement turn knows the original intent
  -- without re-deriving it from prose, and (2) the UI can show the brief and
  -- let the owner re-edit it.
  --
  -- WHY NOT REUSE `request`. trip_plans.request already holds plan-trip's raw
  -- TripInput. It stays exactly where it is: it is `not null` with no default,
  -- it is what every applied row has, and 20260808000001's adopt_trip() reasons
  -- about it by name. `brief` is the forward-looking, schema-checked,
  -- re-editable version; `request` is frozen as the historical record of what
  -- the one-shot planner was sent. The backfill below seeds brief from request
  -- so no existing plan starts life un-refinable.
  --
  -- The `object` check is not pedantry: brief is read back by the edge function
  -- and rendered by the UI, and a brief of `"nope"` or `[1,2,3]` is a jsonb the
  -- ->> operators return null for all the way down, i.e. a silent wrong answer
  -- rather than a loud one.
  add column if not exists brief jsonb not null default '{}'::jsonb
    check (jsonb_typeof(brief) = 'object'),

  -- The exact retrieved candidate set this plan was generated from. See the
  -- header: this is the grounding anchor, and it is the reason a refinement can
  -- be cheap (no re-retrieval) AND safe (the model's choices are still bounded
  -- by what the server vetted).
  --
  -- NO FOREIGN KEY, deliberately. A uuid[] cannot carry one, and the array is a
  -- point-in-time snapshot: if a place is later removed from the catalog we
  -- want the historical record of what the plan was grounded on to survive, not
  -- to have the row silently rewritten under us. The integrity rule that
  -- actually matters is enforced where it can be -- the edge function must join
  -- candidate_ids against public.places before handing anything to the model,
  -- so a uuid that no longer resolves simply drops out of the candidate set.
  -- STATED PLAINLY so nobody assumes otherwise: this column does not guarantee
  -- its elements exist in public.places. It guarantees only that no client put
  -- them there.
  --
  -- Cardinality cap. CORRECTED, because the number this used to cite was wrong
  -- in both halves: places_near has NO clamp of its own -- it applies whatever
  -- max_results its caller passes -- and plan-trip passes 120 on the create
  -- path and 500 on the wishlist-widening and rehydrate paths. Retrieval is
  -- therefore not bounded at 80 and never was.
  --
  -- The cap is still right, because what actually bounds this column sits one
  -- step further down: plan-trip ranks the retrieved pool and slices it to
  -- MAX_CANDIDATES (40, or 28 for trips of 6+ days) BEFORE it stores anything,
  -- so a stored candidate set is at most 40 elements. 500 is ~12x headroom over
  -- that real shape, and equal to the widest single retrieval the function can
  -- issue, while still being far below "every place in the catalog", which is
  -- the shape a widening attack wants. If this number ever needs to move it is
  -- the PRE-STORAGE cap that it has to clear, not the retrieval width.
  add column if not exists candidate_ids uuid[] not null default '{}'::uuid[]
    check (cardinality(candidate_ids) <= 500),

  -- Server-side turn counter, checked and incremented by the edge function.
  -- The DB's job is not to know the product cap (that is a tier decision the
  -- edge function owns); the DB's job is to make sure the number can only ever
  -- come from us and can only ever go up. The 100 ceiling is a backstop against
  -- a runaway retry loop in our OWN code, not against a user -- it turns an
  -- infinite increment loop into a loud constraint violation instead of a
  -- silent invoice.
  add column if not exists refinements_used int not null default 0
    check (refinements_used >= 0 and refinements_used <= 100),

  -- Append-only history of prior itineraries, for undo:
  --   [{ "itinerary": {...}, "summary": "...", "at": "2026-08-28T12:00:00Z" }]
  -- NEWEST LAST. That ordering is a contract, not an accident -- the cap in the
  -- trigger below trims from the FRONT, so getting it backwards would silently
  -- discard the recent history instead of the ancient history.
  add column if not exists revisions jsonb not null default '[]'::jsonb
    check (jsonb_typeof(revisions) = 'array'),

  -- OPTIMISTIC CONCURRENCY TOKEN. Monotonic, server-derived, and the thing
  -- every server write to this row compare-and-swaps on. Full semantics -- who
  -- bumps it, what the CAS predicate is, and why refinements_used cannot do
  -- this job -- are in rule (2b) of the guard trigger below; that is the
  -- authoritative statement and the edge function must match it exactly.
  --
  -- int, not bigint: bumped once per state-changing write, so 2.1e9 is a
  -- lifetime for one trip row. NO upper CHECK, deliberately -- refinements_used
  -- can carry a 100 ceiling because a runaway there is always our bug, but hand
  -- edits bump this column and hand edits are legitimate and unbounded, so a
  -- ceiling here would eventually brick a well-used trip instead of catching
  -- anything. `>= 0` still binds every writer including psql, which is the
  -- floor the monotonicity argument rests on.
  add column if not exists version int not null default 0
    check (version >= 0);

-- ------------------------------------------------------------ revision_count
--
-- A SEPARATE ALTER TABLE, deliberately. A generation expression is resolved
-- against the table as it already stands, and `revisions` is added by the
-- statement above -- referencing a column added in the SAME ALTER TABLE is at
-- best implementation-defined, and this file has no database to test that
-- assumption against. Two statements cost nothing and remove the question.
--
-- WHY IT EXISTS. The client needs to know whether a trip HAS undoable history,
-- so Undo can appear on a trip reopened in a later session. It does not need
-- the history itself: rule (1) makes revisions service-role-write-only, so undo
-- is a server call no matter what the client can see. Before this column the
-- only way to answer "are there any revisions?" was to select the entire array
-- -- up to ten full itineraries and 256 KiB -- and take its length.
--
-- CONSIDERED AND REJECTED: revoking client SELECT on `revisions` instead. Note
-- for anyone who reaches for that later -- the obvious form does not even work.
-- `revoke select (revisions) ... from authenticated` is a silent no-op while
-- the role holds table-level SELECT, which it does (Supabase grants ALL on new
-- public tables and this file revokes only INSERT and UPDATE); Postgres accepts
-- it and changes nothing. Doing it properly means dropping table-level SELECT
-- and maintaining an explicit column allowlist forever, whose failure mode is
-- that a column added in some future migration silently reads back as nothing
-- and nobody connects it to a grant written months earlier. That is a large and
-- durable footgun, and what it buys is stopping a user from reading their OWN
-- trip's history -- already confined by RLS to trips they own or belong to, and
-- not a leak of anyone else's data. Wrong trade. This column reaches the same
-- payload goal from the other side: with a plain int available, nothing has a
-- reason to select the blob, so it stops being fetched rather than being
-- forbidden. The fence that actually matters -- only the service role may WRITE
-- revisions -- is untouched, and that is the half that makes a history a
-- history.
--
-- UNWRITABLE BY CONSTRUCTION, which is stronger than any grant or trigger rule:
-- Postgres rejects an INSERT or UPDATE that names a generated column, whoever
-- sends it, service role included. So it needs no entry in the guard, no
-- revoke, and it cannot drift from revisions even if our own code is wrong.
--
-- STORED rather than virtual: read on every list query, recomputed only when
-- revisions changes, which is the right way round for this access pattern. Both
-- functions in the expression are IMMUTABLE, as a generation expression
-- requires. The jsonb_typeof guard mirrors the trigger's and is there for the
-- same reason: the expression is evaluated before the column's own CHECK, so a
-- non-array revisions would otherwise raise inside jsonb_array_length with an
-- opaque error instead of failing on the named constraint a moment later.
--
-- ORDERING: the guard trigger trims revisions BEFORE the row is stored, so this
-- counts the trimmed array and can never exceed the trigger's cap of 10.
--
-- APPLY COST, worth knowing before this is run by hand: adding a STORED
-- generated column REWRITES the table under an ACCESS EXCLUSIVE lock. That is a
-- different cost from the nullable, defaulted adds above, which are
-- catalog-only. trip_plans holds one row per planned trip, so the rewrite is a
-- blip -- but it is a rewrite, and it is inside this transaction with
-- everything else.
alter table public.trip_plans
  add column if not exists revision_count int not null
    generated always as (
      case when jsonb_typeof(revisions) = 'array'
           then jsonb_array_length(revisions)
           else 0 end
    ) stored;

-- No new index. Nothing queries on any of these six: they are read as part of
-- the row the client already fetches by id or by user_id (trip_plans_user_idx),
-- and candidate_ids is never searched, only read back whole. A GIN index on
-- candidate_ids would be write amplification for a query that does not exist.

-- ================================================================= backfill
--
-- Seed brief from request so every plan that already exists is refinable and
-- re-editable on day one -- which is the point of storing the brief at all. The
-- shapes line up: plan-trip persists `request: input`, the raw TripInput
-- (region / days / rounds / stops / style / notes), which is precisely the
-- structured intent brief is for.
--
-- Filtered three ways, and each filter earns its place:
--   * `brief = '{}'::jsonb` -- makes the statement a zero-row no-op on a second
--     run, and guarantees a retry can never clobber a brief a user has edited.
--   * `jsonb_typeof(request) = 'object'` -- request is `not null` but otherwise
--     unconstrained, so a scalar or array in there would violate brief's own
--     CHECK and abort the whole migration for one malformed legacy row.
--   * the size filter -- same reasoning against the 16 KiB cap the trigger
--     enforces below. A row skipped by either filter keeps brief = '{}', which
--     the edge function must read as "no stated intent, ask the user" -- the
--     same state a trip adopted via adopt_trip() or created via the mobile
--     "adopt a template" path is in.
--
-- ORDERED BEFORE the guard trigger on purpose, exactly as 20260729000001
-- ordered its invite_code rotation before trip_plans_immutable: a migration
-- carries no JWT, so it is not obliged to look like an authorized writer. (In
-- practice a hand-apply resolves to session_user = postgres and
-- private.is_service_role() returns true, so it would pass either way -- but
-- relying on that is relying on WHO ran psql.)
--
-- The two triggers already on this table do fire for this UPDATE and both pass:
-- trip_plans_guard_immutable touches only user_id / invite_code / created_at,
-- and trip_plans_guard_publish only editor_pick / published_at / publish_*.
-- None of those columns is written here.
update public.trip_plans
   set brief = request
 where brief = '{}'::jsonb
   and jsonb_typeof(request) = 'object'
   and octet_length(request::text) <= 16384;

-- ============================================================ column guard
--
-- WHY THIS IS A NEW FUNCTION AND NOT AN EDIT TO trip_plans_guard_immutable.
-- The brief for this work said the immutability guard "must now also decide who
-- may write each of your new columns", and it does -- but as a companion, which
-- is the pattern 20260808000001 already established with
-- trip_plans_guard_publish rather than editing the 20260729000001 function.
-- Two concrete reasons, beyond consistency:
--
--   1. RE-RUN SAFETY ACROSS FILES. trip_plans_guard_immutable is defined with
--      `create or replace` in 20260729000001. If this file edited that same
--      function, re-running 20260729000001 -- which its own header advertises
--      as safe -- would silently DELETE every rule below and reopen the quota
--      and grounding holes with no error anywhere. A migration's guarantees
--      must not depend on nobody replaying an older migration.
--   2. trip_plans_immutable is `before update` and reads OLD. Half the job here
--      is on the INSERT path (see below), which that trigger structurally
--      cannot reach.
--
-- Plain function, NO SECURITY DEFINER -- same choice as both sibling guards. It
-- must run as the invoking role so private.is_service_role() sees the real
-- caller; auth.uid() reads the request JWT GUC and is unaffected either way.
--
-- search_path is `public, private, pg_temp`: public for the table, private for
-- is_service_role(), pg_temp LAST so a caller cannot shadow an unqualified name
-- with a temp object. Every call below is schema-qualified anyway.
create or replace function public.trip_plans_guard_conversation()
returns trigger language plpgsql
set search_path = public, private, pg_temp as $$
declare
  v_service boolean := private.is_service_role();
  -- Which caps to apply, decided inside the tg_op branches below. These exist
  -- so the caps section NEVER touches OLD: in a BEFORE INSERT trigger OLD is an
  -- unassigned record, `or` is not guaranteed to short-circuit, and
  -- `tg_op = 'INSERT' or new.x is distinct from old.x` is therefore a trap
  -- rather than a shorthand.
  v_check_brief boolean := false;
  v_check_revisions boolean := false;
  -- Cap constants live here rather than in a settings table: they are schema
  -- policy, and a settings table would be one more thing a client might reach.
  k_max_revisions constant int := 10;
  k_max_brief_bytes constant int := 16384;      -- 16 KiB
  k_max_revisions_bytes constant int := 262144; -- 256 KiB
begin
  if tg_op = 'INSERT' then
    -- ---------------------------------------------------------- INSERT path
    -- THIS IS NOT A THEORETICAL PATH. apps/mobile's useCreateTrip INSERTs into
    -- trip_plans directly (the "adopt a template" flow), so clients hold a real
    -- INSERT privilege on this table. Without this branch, the entire
    -- service-role fence on the UPDATE path is decorative: an attacker does not
    -- need to PATCH candidate_ids if they can simply POST a brand-new trip row
    -- with candidate_ids already set to whatever they like, and then ask the
    -- edge function to refine THAT row. Same for refinements_used.
    --
    -- Server-owned columns are RE-DERIVED rather than rejected -- the pattern
    -- 20260808000001 used in condition_reports_sanitize. Silently forcing the
    -- default keeps every existing insert working (a client that never heard of
    -- these columns is unaffected) while making the supplied value impossible
    -- to observe, which is exactly the semantics we want: not "you may not ask
    -- for this", but "asking for this has no effect".
    --
    -- This also does the right thing for adopt_trip(): a trip cloned from
    -- somebody else's published plan starts with an EMPTY candidate set and a
    -- ZERO counter, rather than inheriting a stranger's grounding snapshot and
    -- a stranger's spent quota. adopt_trip is SECURITY DEFINER but runs under
    -- the adopter's JWT, so is_service_role() is correctly false there.
    -- CONSEQUENCE FOR THE EDGE FUNCTION, stated so it is not discovered at
    -- runtime: refining an adopted or hand-created trip finds candidate_ids
    -- empty and MUST re-run retrieval for that first turn.
    --
    -- version is forced to 0 here for the same reason and with one extra one: a
    -- row whose version did not start at 0 would let a client hand the edge
    -- function a token it had already chosen, and a CAS whose starting value
    -- the attacker picked is not a CAS. A service-role INSERT is left alone --
    -- there is no prior version for a new row to be inconsistent with, and
    -- plan-trip does not send the column -- so in practice every row is born at
    -- the default, 0.
    if not v_service then
      new.candidate_ids    := '{}'::uuid[];
      new.refinements_used := 0;
      new.revisions        := '[]'::jsonb;
      new.version          := 0;
    end if;

    -- A new row is validated in full; there is no prior value to grandfather.
    v_check_brief     := true;
    v_check_revisions := true;

  else
    -- ---------------------------------------------------------- UPDATE path

    -- (1) THE SERVER-OWNED THREE. Not owner-writable. Not member-writable.
    -- Service role only, on the direct-PATCH path and every other path.
    --
    -- Note this is checked against nothing but the role: the OWNER is refused
    -- here as flatly as a member is, which is the deliberate part. The attack
    -- that matters is not "a member escalates", it is "the person paying for
    -- the feature resets their own meter", and an owner-scoped rule would be
    -- precisely no defence against it. Owning a row does not make its quota
    -- counter your data.
    if (new.candidate_ids    is distinct from old.candidate_ids
     or new.refinements_used is distinct from old.refinements_used
     or new.revisions        is distinct from old.revisions)
       and not v_service then
      raise exception 'not_authorized';
    end if;

    -- (2) THE METER ONLY EVER GOES UP -- for EVERYONE, service role included.
    -- (1) already stops clients; this stops us. A bug in the edge function that
    -- writes a stale count, a replayed request, or an admin fat-fingering a
    -- "fix" in the SQL editor all fail loudly instead of quietly refunding
    -- turns we already paid for.
    --
    -- This does not box in "let me start over": starting over is a NEW
    -- trip_plans row, which is also how the monthly plan quota is counted
    -- (plan-trip counts rows created this month), so the rule is aligned with
    -- the billing model rather than fighting it. A fresh row starts at 0
    -- because tg_op = 'INSERT' never reaches this branch.
    if new.refinements_used < old.refinements_used then
      raise exception 'cannot_decrease_refinements_used';
    end if;

    -- (2b) version IS DERIVED HERE AND SUPPLIED BY NOBODY -- not the owner, not
    -- a member, not the service role, not a psql session. This is the
    -- optimistic-concurrency token every server write CASes on, and it exists
    -- because refinements_used demonstrably cannot do that job:
    --
    --   * REFINE vs UNDO. Undo CASes on refinements_used, which undo never
    --     changes. So a refine that read the row before an undo committed still
    --     MATCHES the guard afterwards: it lands, silently reverts the undo,
    --     and resurrects the history entry the undo had popped.
    --   * REFINE vs HAND EDIT. A member editing the itinerary through
    --     useUpdateTrip does not touch refinements_used either, so a concurrent
    --     refine sails through its guard and overwrites their edit wholesale --
    --     and per adversarial item 6 a hand edit leaves no revisions entry, so
    --     undo cannot recover it. That is the "full-row upsert silently nulled
    --     the user's notes" pattern, one layer up.
    --   * REFINE vs REFINE. A counter alone cannot distinguish "nothing
    --     changed" from "something else changed".
    --
    -- AUTOMATIC, NOT WRITER-SUPPLIED, and that choice costs the CAS nothing --
    -- which is why it is the choice. A PostgREST compare-and-swap is expressed
    -- in the FILTER, not in the body:
    --
    --   PATCH /rest/v1/trip_plans?id=eq.<id>&version=eq.<v read this request>
    --   Prefer: return=representation
    --   body MUST NOT contain "version"
    --   zero rows in the representation => somebody wrote first => 409 conflict
    --
    -- The filter is evaluated against the OLD row and this trigger then sets
    -- the new value, so "only if version is still N" and "the server owns N+1"
    -- are both true in one statement. Reading the representation back gives the
    -- writer the new version for a following write in the same request.
    --
    -- Supplying a value is REFUSED rather than tolerated, so the two mechanisms
    -- can never disagree about who owns the number. A raise here means a writer
    -- has the contract wrong -- something to discover on the first call, not at
    -- 3am. Note this is strictly stronger than the monotonicity rule (2)
    -- applies to refinements_used: "may not decrease" is trivially true when
    -- nobody may move it at all.
    if new.version is distinct from old.version then
      raise exception 'version_is_server_derived';
    end if;

    -- THE BUMP. Every write that changes state a server write also writes.
    -- itinerary is in this list because the hand-edit race above is the whole
    -- point of the column.
    --
    -- candidate_ids is in it too, and the reason is worth stating because an
    -- earlier draft left it out. The justification for omitting it was "nothing
    -- ever writes it alone -- plan-trip only sets it in the rehydrate write,
    -- alongside itinerary and refinements_used". That is TRUE TODAY and it is a
    -- fact about the current edge function, NOT a property of this schema:
    -- nothing here stops a service-role write from touching candidate_ids by
    -- itself. A later re-grounding job, repair script or backfill that did so
    -- would leave version unmoved, and a stale refine's CAS would still match --
    -- silently defeating the concurrency guard for the exact column the rest of
    -- this file exists to protect. A soft absolute is bad anywhere; in the CAS
    -- contract it is the worst place to put one.
    -- Listing it costs nothing. No write today changes candidate_ids without
    -- also changing itinerary and refinements_used, so no CAS that passes now
    -- starts failing. And if some future write ever does change it alone, a 409
    -- is the CORRECT answer, because a changed grounding set genuinely
    -- invalidates any refinement still in flight against the old one.
    --
    -- title and start_date are NOT in the list, on purpose: no server write
    -- overwrites them, so bumping on a rename would only make honest
    -- refinements lose a CAS they had no reason to lose.
    --
    -- `revisions` IS LOAD-BEARING HERE IN A WAY THAT IS NOT OBVIOUS, and the
    -- mirror of the candidate_ids point above: a WRITE that fails to bump is
    -- the same defect as a COLUMN that fails to bump. It is what makes the
    -- refine COMMIT bump on a DECLINE turn. When the model declines an
    -- instruction it returns the plan unchanged, so the committed itinerary can
    -- be jsonb-equal to the stored one and `is distinct from` finds nothing on
    -- that column. The bump then rests ENTIRELY on revisions -- which holds,
    -- because the commit's append is unconditional and every entry carries a
    -- fresh `at` timestamp, so the array differs even when the itinerary does
    -- not. Verified against plan-trip's three UPDATE bodies: undo
    -- {itinerary, revisions}, refine claim {refinements_used, ...}, refine
    -- commit {itinerary, revisions}.
    -- SO: do NOT drop revisions from this list on the reasoning that it only
    -- ever changes alongside itinerary. It does not, and declines would
    -- silently stop bumping -- the same stale-CAS hole this column exists to
    -- close, reached by a different route.
    --
    -- ORDERING, also load-bearing: this bump is computed BEFORE the revisions
    -- trim in the caps section below, so it compares the array AS SUPPLIED. An
    -- eleventh entry appended to a full history therefore bumps even though the
    -- trim is about to drop the oldest one. Moving the trim above this block
    -- would not change that outcome today, but it would make the bump depend on
    -- trim behaviour, which is a coupling worth not having.
    if new.itinerary        is distinct from old.itinerary
    or new.revisions        is distinct from old.revisions
    or new.refinements_used is distinct from old.refinements_used
    or new.brief            is distinct from old.brief
    or new.candidate_ids    is distinct from old.candidate_ids then
      new.version := old.version + 1;
    end if;

    -- (3) brief IS OWNER-ONLY. Members may hand-edit the itinerary (see the
    -- decision block below) but may not rewrite what the trip IS.
    --
    -- Same reasoning 20260728000001/20260828000001 applied to visit_times.at
    -- and .place_id, and 20260808000001 applied to published_at: the brief is a
    -- SHARED FACT the whole trip is derived from -- region, dates, how many
    -- rounds. A member who could edit it could move four other people's golf
    -- trip to a different state and a different week by changing one jsonb, and
    -- every subsequent refinement would faithfully honour the change. Editing
    -- the itinerary is collaboration; editing the brief is deciding.
    --
    -- Compared against OLD.user_id, which is the whole reason this lives in a
    -- trigger: a WITH CHECK sees only NEW and could be satisfied by an attacker
    -- who also changed user_id in the same statement. (They cannot -- that is
    -- trip_plans_immutable's job -- but this rule does not lean on that.)
    if new.brief is distinct from old.brief
       and auth.uid() is distinct from old.user_id
       and not v_service then
      raise exception 'not_owner';
    end if;

    -- Only what actually changed gets re-validated. See the caps block.
    v_check_brief     := new.brief     is distinct from old.brief;
    v_check_revisions := new.revisions is distinct from old.revisions;
  end if;

  -- ------------------------------------------------------- caps and shapes
  --
  -- Applied on INSERT always, and on UPDATE only to columns that ACTUALLY
  -- CHANGED. That asymmetry is deliberate and it is a bug-avoidance rule, not a
  -- shortcut: validating an unchanged column on every update would let one
  -- oversized legacy value BRICK the row -- every future `update trip_plans set
  -- title = ...` would fail on a brief nobody touched. A guard that can trap a
  -- user's data is worse than the growth it prevents.
  --
  -- The size caps are here rather than in a CHECK constraint because they need
  -- a jsonb -> text cast, whose volatility labelling is not something a CHECK
  -- should be made to depend on. A trigger has no such constraint.

  if v_check_brief then
    -- Unbounded jsonb on a row anyone can PATCH is a storage attack: a single
    -- field can carry ~1 GB before TOAST complains, and the brief is echoed
    -- into every prompt, so an oversized brief is a token bill as well as a
    -- disk bill. 16 KiB is orders of magnitude above a real brief (a region
    -- string, some dates, a handful of tags and a paragraph of notes).
    if octet_length(new.brief::text) > k_max_brief_bytes then
      raise exception 'brief_too_large';
    end if;
  end if;

  if v_check_revisions then
    -- THE CAP, enforced in the schema layer as asked. A chatty session is the
    -- expected case, not the adversarial one -- twenty turns on one trip is a
    -- user enjoying the feature -- so the cap TRIMS instead of raising. Raising
    -- would mean the eleventh perfectly legitimate refinement fails, and the
    -- edge function would have to know the cap to avoid it. Trimming means the
    -- edge function can append naively forever and the row stays bounded.
    --
    -- Keeps the LAST 10 (newest, per the column's documented ordering) by
    -- taking the highest ordinalities and re-aggregating in ascending order, so
    -- the surviving array is still oldest-first.
    --
    -- Guarded on jsonb_typeof because a BEFORE trigger runs before the column's
    -- CHECK: without this, a non-array revisions would blow up inside
    -- jsonb_array_length with an opaque error instead of failing on the named
    -- constraint a moment later.
    if jsonb_typeof(new.revisions) = 'array'
       and jsonb_array_length(new.revisions) > k_max_revisions then
      new.revisions := (
        select coalesce(jsonb_agg(s.e order by s.ord), '[]'::jsonb)
        from (
          select e, ord
            from jsonb_array_elements(new.revisions) with ordinality as t(e, ord)
           order by ord desc
           limit k_max_revisions
        ) s
      );
    end if;

    -- The count cap alone does not bound the row: ten entries of 100 MB each is
    -- ten entries. An itinerary is a few KB, so 256 KiB across ten revisions is
    -- ~10x headroom on the real shape while making "grow a trip_plans row until
    -- something falls over" impossible. Checked AFTER the trim, so a legitimate
    -- oversized-because-too-many array is trimmed first and only a genuinely
    -- fat payload raises.
    if octet_length(new.revisions::text) > k_max_revisions_bytes then
      raise exception 'revisions_too_large';
    end if;
  end if;

  return new;
end $$;

-- INSERT and UPDATE. Not DELETE: deleting your own trip is already an owner-only
-- policy from 20260724000001 and none of this state outlives the row.
--
-- FIRING ORDER, since there are now three BEFORE UPDATE triggers on this table.
-- Postgres fires them alphabetically: trip_plans_conversation_guard <
-- trip_plans_immutable < trip_plans_publish_guard. All three are validators and
-- the first to raise wins, so order changes only WHICH error message a
-- multi-column attack sees, never whether it is stopped. The one trigger here
-- that MUTATES the row (the revisions trim) touches a column neither sibling
-- reads, so there is no interaction.
drop trigger if exists trip_plans_conversation_guard on public.trip_plans;
create trigger trip_plans_conversation_guard
  before insert or update on public.trip_plans
  for each row execute function public.trip_plans_guard_conversation();

-- =================================================================== grants
--
-- The trigger above is the property of the table; this is the privilege that
-- means the trigger is not the only thing standing there. 20260808000001 made
-- the same move for profiles.content_suspended_at and gave the reason: RLS has
-- no column granularity, so "only the server writes this column" is a GRANT
-- statement or it is nothing.
--
-- Supabase's default privileges hand ALL on new tables in `public` to anon and
-- authenticated, and trip_plans has never been revoked -- so as of right now,
-- before this block runs, an authenticated user holds INSERT and UPDATE on
-- EVERY column of trip_plans, fenced only by RLS (row-scoped) and the two
-- existing triggers (column-scoped, but only for the columns they name).
-- editor_pick, published_at and publish_* have been relying on trigger checks
-- alone; after this block they are not reachable by privilege either.

revoke insert, update on public.trip_plans from anon, authenticated;
-- anon is included for completeness. It has no RLS policy path today, so this
-- removes a privilege that was already unusable -- which is the point: the next
-- policy somebody adds should not silently inherit a write grant.

-- INSERT: exactly the columns apps/mobile's useCreateTrip sends, plus brief.
-- `request` is here because it is `not null` with no default -- the insert
-- literally cannot succeed without it.
grant insert (user_id, title, start_date, request, brief, itinerary)
  on public.trip_plans to authenticated;

-- UPDATE: exactly the columns apps/mobile's useUpdateTrip sends, plus brief.
grant update (title, start_date, brief, itinerary)
  on public.trip_plans to authenticated;

-- WHAT IS DELIBERATELY ABSENT, and why none of it is a regression:
--
--   candidate_ids, refinements_used, revisions -- the point of this file.
--   revision_count            -- generated: Postgres refuses any INSERT or
--                                UPDATE naming it, from every caller including
--                                the service role, so there is no grant to
--                                withhold. Readable by the client, which is the
--                                entire point of it.
--   version                   -- writable by NOBODY, us included. The guard
--                                derives it (rule 2b) and raises
--                                'version_is_server_derived' on any supplied
--                                value, so the missing grant here is the
--                                second fence rather than the first.
--   user_id, id, created_at   -- frozen by trip_plans_immutable since
--                                20260729000001; now a privilege fact too.
--   invite_code               -- owner-only via trip_plans_immutable, and the
--                                client already uses rotate_invite_code(), which
--                                is SECURITY DEFINER and runs with the function
--                                owner's privileges, so it is unaffected.
--   published_at, publish_*   -- guarded by trip_plans_publish_guard, and the
--                                client already uses publish_trip() /
--                                unpublish_trip(), both SECURITY DEFINER.
--   editor_pick               -- service-role-only curation. Previously the
--                                trigger was the only fence; now the privilege
--                                is gone as well.
--   request                   -- superseded by brief. Frozen after insert on
--                                purpose: two columns holding "what was asked
--                                for" is already one too many, and letting the
--                                client edit only the legacy one is how they
--                                drift apart. Reversible with one grant if a
--                                real need appears.
--
-- adopt_trip(), publish_trip(), unpublish_trip(), join_trip(),
-- rotate_invite_code() and vote_trip() are ALL SECURITY DEFINER and execute
-- with the function owner's privileges, so no column-level revoke here reaches
-- any of them. plan-trip and the refinement endpoint use the service key, which
-- bypasses both RLS and these grants. VERIFIED STATICALLY against the applied
-- migrations and apps/mobile/src/lib/data.ts; not executed.
--
-- SELECT is untouched, and deliberately so -- see revision_count's comment for
-- why fencing `revisions` out by privilege was considered and rejected. Members
-- can read all six new columns, which is correct: refinements_used is what the
-- UI renders as "3 of 10 refinements left", the brief is the shared statement of
-- what the trip is, revision_count is what decides whether Undo appears, and
-- version is a counter that discloses nothing (the edge function reads it under
-- the service key anyway; a client reading it learns only that the row has been
-- written to). revisions itself stays readable to owners and members -- it is
-- their own trip's history, RLS already confines it to them, and revision_count
-- means nothing needs to pull the blob in practice.
-- This matches the posture
-- 20260828000002 documents for invite_code -- a member reads the whole row,
-- because membership exists at the owner's invitation.

-- ================================================================ plan_turns
--
-- THE METERING LEDGER. In this file rather than a follow-up because it fixes
-- two bugs of one class, and the second is already written down a few hundred
-- lines below as the "RESIDUAL, ACCEPTED" of adversarial item 1.
--
-- WHAT IS BROKEN WITHOUT IT. Both quota questions are answered today by
-- counting or summing SURVIVING trip_plans rows:
--   * the monthly PLAN cap counts trip_plans rows created this month, so
--     deleting a plan refunds the slot;
--   * the monthly REFINEMENT cap sums refinements_used over this month's rows,
--     so a trip created last month refines free this month, and deleting a trip
--     refunds every turn ever spent on it.
-- A meter whose reading falls when you delete the evidence is not a meter. The
-- fix cannot be another column on trip_plans, because any column on that row
-- dies with the row. It has to be a separate append-only record of turns TAKEN,
-- which is what this is.
--
-- `on delete set null` ON trip_id, NOT CASCADE, AND THAT IS THE ENTIRE POINT.
-- Cascading would delete the ledger rows along with the trip and preserve the
-- refund loop precisely as it stands. Setting null lets the turn outlive the
-- trip: trip_id is a convenience for support and debugging and costs nothing to
-- lose, whereas losing the ROW costs us the meter. Note the asymmetry with
-- user_id, which is `not null` and cascades from profiles -- correct in the
-- other direction, because a deleted account has no quota left to meter and
-- keeping its ledger would be retaining personal data for no purpose.
--
-- BOTH KINDS RECORDED. 'create' when a plan is generated, 'refine' per
-- refinement turn, so one table answers both caps and the edge function counts
-- rows in the current month instead of summing a column on rows that may not be
-- there any more. The CHECK pins the vocabulary: a typo'd kind would otherwise
-- be a turn that silently counts toward neither cap.
--
-- NO product cap here, exactly as refinements_used carries none: the DB's job
-- is to hold an honest count, and what that count is allowed to reach is a tier
-- decision the edge function owns.
--
-- SERVICE-ROLE ONLY, FENCED TWICE, same posture as the columns above. This is
-- billing state with no user-facing read at all -- the client learns its
-- remaining quota from the edge function's response envelope, never by querying
-- the meter, which is also why there is nothing to leak here.
--   * RLS enabled with ZERO policies: deny-by-default for every non-service
--     caller even if somebody restores a grant in six months. The service role
--     bypasses RLS, so the edge function is unaffected.
--   * ALL privileges revoked from anon and authenticated, because Supabase's
--     default privileges hand ALL on a new table in `public` to both, and a
--     table created inside this migration inherits exactly that the moment it
--     exists.
-- Both fences earn their place: RLS alone still leaves a table an authenticated
-- role holds privileges on, and a revoke alone is one `create policy` away from
-- being the only thing standing there. This is the same belt-and-braces the
-- server-owned columns get, for the same reason -- it is a charge on our
-- inference bill.
--
-- WRITE PATH IS INSERT-ONLY BY CONVENTION, not by trigger. No guard is added:
-- with zero policies and no grants there is no non-service caller to guard
-- against, and a guard against ourselves would be the fourth trigger on a
-- feature that already has three. If a future change ever grants a client
-- anything here, that decision has to bring an immutability trigger with it --
-- the ledger's value is entirely in nobody being able to edit it.
create table if not exists public.plan_turns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  trip_id uuid references public.trip_plans (id) on delete set null,
  kind text not null check (kind in ('create', 'refine')),
  created_at timestamptz not null default now()
);

-- Every read is "this user, this month": leading equality on user_id, range on
-- created_at, which is the order this index has to be in to serve it with one
-- scan. No index on trip_id -- nothing looks a turn up by trip, and `on delete
-- set null` does not need one to do its work on a table this size.
create index if not exists plan_turns_user_month_idx
  on public.plan_turns (user_id, created_at);

alter table public.plan_turns enable row level security;
revoke all on public.plan_turns from anon, authenticated;

-- ------------------------------------------------------ plan_turns backfill
--
-- WHY THIS EXISTS AT ALL, since it looks like pointless duplication to anyone
-- who does not know the function changed shape: plan-trip used to answer "how
-- much quota has this user spent" by counting SURVIVING trip_plans rows. It now
-- counts rows in this ledger. The ledger starts empty, so without this
-- statement every existing user's history becomes invisible to the meter on the
-- day this applies -- a free user who already spent their trial gets another
-- one, and a Pro user's month resets. Small numbers today, but it is a silent
-- giveaway on a metered feature and it costs one statement to avoid.
--
-- EACH TRIP'S OWN created_at, never now(). The Pro cap reads a month window;
-- stamping every historical plan with the apply time would drop the entire back
-- catalogue into the current month and lock Pro users out instead. Copying the
-- source timestamp is what makes the reconstruction honest.
--
-- 'create' ONLY. No refinement has ever happened -- the feature does not exist
-- until this migration lands -- so there is no refine history to reconstruct
-- and a backfilled refine row would be a fabricated charge.
--
-- RE-RUNNABLE via `not exists`. There is no natural unique key here (a user may
-- legitimately create two plans in the same second), so `on conflict do nothing`
-- would need a constraint invented purely to support it. The guard also makes a
-- re-run after a partial failure safe, which matters more than elegance on a
-- file that is applied by hand.
--
-- ================== THE EXCLUSION, WHICH IS THE PART TO READ ================
-- NOT every trip_plans row is a turn taken. Two paths create a trip WITHOUT any
-- LLM call and therefore without spending quota:
--   * adopt_trip() -- cloning somebody's published plan. CERTAIN to identify:
--     20260808000001 has it write a provenance stub as `request`, deliberately
--     not copying the author's, so `adopted_from` is present on exactly these
--     rows and on nothing else.
--   * apps/mobile's useCreateTrip -- the "adopt a template" flow, which INSERTs
--     `request = {region, days, stops: 0}` directly. Identified by shape rather
--     than by a marker, so it is keyed on the literal `stops = 0` and not on
--     the key merely being present -- the previous planner form also sent
--     `stops`, on genuine paid creates. See the predicate's own comment.
-- Going forward NEITHER writes a plan_turns row, because only plan-trip does.
-- So backfilling them would put rows in this ledger that the ledger's own writer
-- would never write, and the count would stop meaning what the column says.
--
-- WHY THAT IS NOT A COSMETIC POINT. plan-trip now reads the free tier as a
-- LIFETIME trial with no month window (`isPro ? monthStart : null`) against
-- FREE_TRIAL_PLANS = 1. A backfilled receipt for a free user is therefore
-- PERMANENT: one row here and they can never generate their one trial plan,
-- and what they see is a bare `upgrade_required` they cannot self-diagnose.
-- Charging somebody forever for a template they tapped once is a worse error
-- than handing out one free plan, and it is the error that arrives as a support
-- ticket rather than as a line on an invoice.
--
-- THE BIAS IS DELIBERATE AND ONE-DIRECTIONAL. Both predicates can only ever
-- WITHHOLD a receipt, never invent one. If the shape test misfires on a genuine
-- plan-trip row the cost is one un-metered plan for one user, once. There is no
-- input to this statement that causes it to over-charge anybody.
--
-- REJECTED ALTERNATIVE, written down because it is the cleverest-looking answer
-- and it will be proposed again: `and cardinality(tp.candidate_ids) > 0` as
-- POSITIVE PROOF that plan-trip created the row. The logic is sound in
-- isolation -- the INSERT guard above forces candidate_ids empty for every
-- non-service-role writer, so a non-empty value cannot come from adopt_trip()
-- or useCreateTrip, and a genuine create always has at least one candidate
-- because plan-trip 422s on an empty region before it inserts.
-- IT IS NONETHELESS FATAL HERE, for a reason that has nothing to do with the
-- logic and everything to do with WHERE IT SITS. candidate_ids is added by THIS
-- FILE, a few hundred lines above, with `default '{}'`. Every row that exists
-- when this statement runs was written before the column did, so every row has
-- cardinality 0, and the predicate matches NOTHING. The backfill would insert
-- zero rows and hand every existing user a complete quota reset -- precisely
-- the giveaway it was written to prevent, delivered by the guard meant to
-- prevent it, with no error anywhere. The test only carries information for
-- rows created AFTER this migration, which are exactly the rows that need no
-- backfill.
-- THE GENERAL LESSON, since this file will grow more backfills: a backfill
-- predicate may only read columns that already held real data BEFORE this
-- migration ran. A column this migration adds is uniformly its default at that
-- moment, and reading it tells you nothing about history.
-- ===========================================================================
insert into public.plan_turns (user_id, trip_id, kind, created_at)
select tp.user_id, tp.id, 'create', tp.created_at
  from public.trip_plans tp
 where jsonb_typeof(tp.request) = 'object'
   -- adopt_trip()'s provenance stub. Function form, not the `?` operator: this
   -- file gets pasted into clients that treat `?` as a bind placeholder.
   and not jsonb_exists(tp.request, 'adopted_from')
   -- useCreateTrip's template stub. VERIFIED against production rather than
   -- inferred: it writes exactly {region, days, stops: 0}, so the literal 0 is
   -- what identifies it. Keying on "has stops, lacks rounds" was too broad --
   -- the PREVIOUS planner form also sent `stops` (alongside budget/notes), and
   -- production holds such a row with stops=3. That is a real generated plan
   -- and must be metered; excluding it would hand that user a free plan.
   -- TripPlannerForm cannot produce 0 -- its stepper floors at 1 -- so no create
   -- from the current client is caught by this. RESIDUAL, ACCEPTED: the
   -- back-compat wire shape bypasses the form, so a body explicitly posting
   -- stops: 0 would be a real create that loses its receipt. It requires a brief
   -- asking for zero rounds, nothing in the app can emit it, and it fails in the
   -- give-away-a-free-plan direction like every other miss here. Recorded so it
   -- is not later mistaken for a new defect.
   and not (
         not jsonb_exists(tp.request, 'rounds')
     and tp.request ->> 'stops' = '0'
   )
   and not exists (
         select 1
           from public.plan_turns pt
          where pt.trip_id = tp.id
            and pt.kind = 'create'
       );

-- ============================================================================
-- DECISION: MAY A MEMBER OF A SHARED TRIP REFINE IT?  NO. REFINEMENT IS
-- OWNER-ONLY. A member may still hand-edit the itinerary.
--
-- STATED HERE BECAUSE THE SCHEMA CANNOT ENFORCE IT. The refinement write
-- arrives under the service key, which bypasses RLS entirely, so the DATABASE
-- cannot tell whose refinement it is. Owner-only lives in the edge function --
-- plan-trip's refine and undo paths both compare the JWT subject to
-- trip.user_id and return 403 not_owner -- and the mobile UI gates the refine
-- affordance on ownership on top of that. This comment exists so the next
-- person does not read a permissive schema note and "fix" the function to
-- match it.
--
-- WHY OWNER-ONLY. A refinement is an LLM call we pay for and it is metered
-- against the OWNER: refinements_used is per plan, and plan-trip additionally
-- totals the owner's spend across their rows for the month. Letting members
-- draw on that is a cost transfer the owner never agreed to -- an invite code
-- buys edit access to the trip, not signing authority on somebody else's
-- metered quota -- and "they're your friends" is not a security control.
--
-- WHAT MEMBERS CAN STILL DO, and this part has not changed: a member may edit
-- the itinerary BY HAND. "trip_plans: update own or member" has granted that
-- since 20260728000002 and this file preserves it -- the grant block above
-- deliberately keeps `itinerary` in the authenticated UPDATE column list. The
-- collaborative golf trip planned by four friends in a group chat is still the
-- feature's reason to exist; what is owner-only is the metered tool, not the
-- trip. Two consequences worth carrying:
--   * a hand edit leaves no revisions entry, so undo does not cover it. Already
--     recorded as adversarial item 6, and unchanged.
--   * a hand edit DOES bump `version` (rule 2b), which is precisely what stops
--     a concurrent owner refinement from overwriting it wholesale.
--
-- WHAT MEMBERS CANNOT DO, and where the line is drawn:
--   * refine or undo -- edge function, 403 not_owner. Not a schema fence.
--   * write brief -- guard rule (3). Editing the itinerary is collaboration;
--     rewriting the brief is deciding that the trip is now in a different
--     state, on different dates. Only the owner decides that.
--   * write candidate_ids, refinements_used or revisions -- guard rule (1),
--     which refuses the owner too.
--   * write version -- guard rule (2b), which refuses everyone, us included.
--   * publish, seize, or rotate the code -- unchanged from the earlier files.
--
-- WHAT THE EDGE FUNCTION MUST DO, since none of the above is expressible in the
-- schema:
--   1. resolve the caller from their JWT and require caller == trip.user_id for
--      refine AND for undo. There is no new helper for this on purpose --
--      20260828000001's rule is that the cheapest version of "every function in
--      public is a POST /rpc/ endpoint" is the helper that does not exist.
--   2. charge every turn to trip_plans.refinements_used on the trip row --
--      never to a per-caller counter.
--   3. re-read refinements_used AND version from the row inside the same
--      request rather than trusting anything the client sent, and CAS on
--      VERSION -- never on refinements_used -- for every server write, refine
--      and undo alike. Rule (2b) has the exact predicate; the short form is
--      `?id=eq.<id>&version=eq.<v>` in the filter, no `version` in the body,
--      empty representation means 409. A claim-then-commit sequence is two
--      writes and each needs its own CAS on the version it read.
-- ============================================================================

-- ============================================================================
-- ADVERSARIAL PASS -- static review, no database was executed against.
--
-- 1. RESET refinements_used FOR UNLIMITED LLM TURNS. **The one that matters**:
--    a direct, repeatable charge on our inference bill by anyone with a valid
--    login. CLOSED, four deep.
--      a. No privilege. `revoke update on trip_plans from anon, authenticated`
--         plus a column grant that omits refinements_used, so
--         PATCH /trip_plans?id=eq.X {"refinements_used": 0} is refused by the
--         executor before RLS or any trigger is consulted.
--      b. No trigger path. trip_plans_conversation_guard rule (1) raises
--         'not_authorized' for ANY change to the column by a non-service caller
--         -- the owner explicitly included, because the owner is the attacker in
--         this scenario. This is the layer that survives someone restoring a
--         table-level grant in six months.
--      c. No downward path at all. Rule (2) refuses any decrease from EVERY
--         caller including the service role, so the counter is monotonic as a
--         property of the table rather than as a property of our code being
--         correct.
--      d. No insert path. tg_op = 'INSERT' forces refinements_used := 0 for
--         non-service callers, so "POST a fresh row with the counter I want"
--         gains nothing -- and creating a row is itself what the MONTHLY quota
--         counts, so the fresh-row route bills against the 20/month plan limit
--         exactly as intended.
--      e. NO REFUND BY DELETION -- newly closed, and it is why public.plan_turns
--         is in this file. The residual previously recorded here was that the
--         monthly quota counts trip_plans ROWS, so deleting a plan and
--         re-planning refunded a monthly slot; the same trick refunded every
--         refinement ever spent on the deleted trip, since the monthly
--         refinement figure summed refinements_used over surviving rows. Both
--         were properties of metering against state that the user can delete.
--         plan_turns records a row per turn TAKEN and its trip_id is
--         `on delete set null`, so the turn outlives the trip and the count
--         cannot be walked back. Predicted as "the fix is a durable ledger
--         table, not a column" and that is what it turned out to be.
--         STILL OPEN UNTIL THE FUNCTION MOVES: the ledger is inert until
--         plan-trip writes to it and counts from it instead of from trip_plans.
--         Creating the table closes nothing on its own.
--         AND NOTE THE OPPOSITE FAILURE, which the backfill above exists to
--         prevent: an empty ledger does not fail closed, it fails OPEN. Every
--         historical plan becomes invisible to the meter, which is a giveaway
--         rather than a lockout. Seeding it is part of the fix, not a tidy-up.
--
-- 2. WIDEN candidate_ids SO THE MODEL PICKS A PLACE THE SERVER NEVER RETRIEVED.
--    CLOSED on both paths. The UPDATE path is refused twice over -- no column
--    grant, and rule (1) raises for every non-service caller. The INSERT path,
--    which is the one an attacker would actually reach for because clients
--    genuinely hold INSERT on this table, is neutralised by re-derivation:
--    whatever is supplied is overwritten with '{}' before the row lands. The
--    no-invented-courses guarantee therefore still rests entirely on the
--    server's own retrieval, exactly as it did when the feature was one-shot.
--    STATED HONESTLY: the column has no FK, so it does not guarantee its uuids
--    resolve to rows in public.places -- only that no client chose them. The
--    edge function must still join candidate_ids to public.places before
--    prompting, which it must do anyway to get names and coordinates.
--
-- 3. GROW A ROW WITHOUT BOUND VIA revisions. CLOSED on count AND on bytes,
--    which is the pair that matters -- a count cap alone is defeated by one fat
--    entry, and a byte cap alone is defeated by drip-feeding. The trim keeps 10
--    (newest), 256 KiB caps the total, and the trim runs BEFORE the byte check
--    so an honest chatty session is trimmed rather than rejected. Both fire for
--    the service role too, so a bug in our own edge function cannot do it
--    either. brief is capped at 16 KiB by the same trigger; candidate_ids is
--    capped at 500 elements by a column CHECK, which binds every writer without
--    exception. NOT CLOSED, and pre-existing: `itinerary` remains uncapped --
--    20260808000001 flagged the same gap for trip_plans.title. A member can
--    still PATCH a large itinerary. Out of scope here, named so it is not
--    mistaken for something this file fixed.
--
-- 4. MEMBER ESCALATION THROUGH A NEW COLUMN. CLOSED. Of the six, three are
--    refused to every non-service caller, version is refused to every caller
--    including us, and revision_count cannot be written by anybody at all
--    because Postgres rejects a write naming a generated column -- so
--    membership buys nothing. The remaining one, brief, is gated on
--    auth.uid() = OLD.user_id -- compared against
--    OLD, which is the entire lesson of the 20260729000001 blocker: a rule
--    stated against NEW can be satisfied by an attacker who rewrites the
--    comparison target in the same statement. Sideways escalation is closed
--    too: the "become the owner first, then write brief" route needs a user_id
--    change, which trip_plans_immutable still refuses to everyone.
--
-- 5. DOES ANY NEW COLUMN LEAK ANOTHER USER'S DATA? NO NEW EXPOSURE.
--    The SELECT surface is unchanged: "trip_plans: read own" and "read as
--    member" from the earlier files still decide who sees a row, and this file
--    adds no policy, no view and no RPC. The one place trip data crosses to
--    strangers is public.published_trips, which selects an EXPLICIT column list
--    (id, title, summary, author_handle, author_id, days, stops, votes,
--    editor_pick, published_at, itinerary) -- no `t.*` -- so brief, revisions,
--    candidate_ids, refinements_used, version and revision_count cannot appear
--    there without somebody editing that view on purpose.
--    THIS MATTERS MORE THAN IT LOOKS. adopt_trip() already refuses to copy
--    `request` into a clone, with the stated reason that it "carries the
--    author's budget and their free-text preferences". `brief` is the SAME
--    CLASS OF DATA and by the same argument must never reach a stranger. It is
--    safe today by construction -- the view predates it and lists its columns,
--    and adopt_trip's INSERT names its columns too, so a clone gets brief =
--    '{}' -- but it is safe by construction, not by a check. FLAGGED FOR THE
--    NEXT PERSON: adding brief to published_trips would leak the author's
--    private planning notes to the whole feed.
--    plan_turns adds no exposure either: RLS on with zero policies and every
--    privilege revoked, so no client can read one row of it, their own included.
--    It holds no content -- a user id, a trip id, a kind and a timestamp -- but
--    the reason it is unreadable is not sensitivity, it is that a meter the
--    metered party can read is a meter they will reason about.
--    Within a trip, members read all six new columns, revisions included. The
--    SELECT surface on this table is left exactly as it was; revision_count
--    exists so that nothing NEEDS to fetch the blob, not so that fetching it is
--    forbidden. That is the intended posture
--    (see the grants block) and not a leak: membership exists because the owner
--    handed out the code.
--
-- 6. FORGE HISTORY IN revisions TO FAKE AN UNDO. CLOSED for clients -- rule (1)
--    makes revisions service-role-only, which is STRICTER than the "owner-
--    writable at most" this file was briefed with, and deliberately so. Two
--    reasons: an undo is a POP plus a RESTORE (write itinerary, shorten
--    revisions) and a client doing that as one PATCH has no atomicity against a
--    refinement landing concurrently; and a history a client can rewrite is not
--    a history. CONSEQUENCE, stated so it is not a surprise: undo cannot be
--    implemented client-side. It is a server call -- cheap, since it spends no
--    tokens. RESIDUAL, ACCEPTED: because a member (or owner) can still PATCH
--    `itinerary` directly under the pre-existing collab policy, a HAND edit does
--    not produce a revision, so undo covers AI turns and not manual ones.
--    CONSIDERED AND REJECTED: having this trigger auto-append OLD.itinerary
--    whenever itinerary changes, which would make revisions genuinely
--    append-only and cover hand edits. Rejected because useUpdateTrip patches
--    the whole itinerary on every ordinary edit, so autosaves would flush the
--    ten slots and evict exactly the AI turns the user wants to undo. A history
--    that forgets the interesting entries is worse than a history with a
--    documented gap.
--
-- 7. THE SERVICE ROLE ITSELF. Not a user-facing attack, but the honest limit of
--    everything above: the service key can write candidate_ids, brief and
--    revisions freely. It cannot write version at all (rule 2b), which is the
--    one column where we fenced ourselves out completely rather than merely
--    in one direction -- an edge function that tried to pick its own token
--    would defeat the CAS it was trying to perform. It cannot decrease
--    refinements_used (rule 2), cannot
--    exceed the caps (rules on both jsonb columns and the column CHECKs), and
--    cannot exceed 100 refinements or 500 candidates. So the blast radius of a
--    leaked service key or a buggy edge function is bounded on the axes that
--    cost money. Carried forward unchanged from 20260828000001: a service-key
--    UPDATE to invite_code is still blocked by trip_plans_immutable, because
--    auth.uid() is NULL for the service role and NULL is distinct from any
--    owner. Repairs go through a DEFINER function or a trigger drop.
--
-- 8. BREAKING THE LIVE APP WITH THE GRANT TIGHTENING. Reviewed statically, no
--    break found. Only INSERT and UPDATE are tightened; SELECT is untouched, so
--    nothing a client reads today stops working. apps/mobile writes trip_plans
--    in exactly two places -- useCreateTrip INSERTs (user_id, title, request,
--    itinerary) and useUpdateTrip PATCHes (title, start_date, itinerary) -- and
--    both column lists are fully covered by the grants above. Every other client
--    write goes through a SECURITY DEFINER RPC and is unaffected by column
--    privileges.
--    ONE CLIENT READ IS MADE OBSOLETE RATHER THAN BROKEN: apps/mobile's
--    useTripRevisionCount selects the whole `revisions` array for one trip to
--    decide whether to show Undo. It keeps working untouched, and should be
--    retired in favour of selecting revision_count in the list query -- an int
--    instead of up to 256 KiB, and no second per-trip request. That is a client
--    change, not a schema dependency: nothing here forces it and nothing here
--    breaks if it is deferred.
--    BEHAVIOUR CHANGE WORTH KNOWING: tooling/eval/community-e2e.py's negative
--    assertions (a member PATCHing user_id / invite_code, an author PATCHing
--    editor_pick) will now fail with a PRIVILEGE error rather than a trigger
--    error. Every one of those assertions is written as `s >= 400`, so they all
--    still pass -- but the error text changes, and that file is not mine to
--    edit.
--
-- 9. RACE TWO WRITES TO THE SAME ROW AND CLOBBER STATE. NEWLY CLOSED, and the
--    reason `version` exists at all. The only compare-and-swap token available
--    before it was refinements_used, and three races defeat it: undo does not
--    change the counter, so a refine holding a pre-undo read still matches the
--    guard and lands on top of a committed undo -- reverting it and
--    resurrecting the history entry it popped; a hand edit through
--    useUpdateTrip does not change the counter either, so a concurrent refine
--    overwrites a member's edit wholesale, and item 6 means undo cannot get it
--    back; and refine-vs-refine cannot be told from nothing-happened. version
--    moves on every write that touches itinerary, revisions, refinements_used,
--    brief or candidate_ids, so a stale writer's filter matches zero rows and
--    PostgREST
--    returns an empty representation the edge function reads as 409.
--    WHAT IT IS NOT. Not a lock -- it is optimistic, the loser refetches and
--    retries, and a turn whose tokens were already spent is lost rather than
--    corrupting the row. Not protection for a multi-write sequence taken as a
--    whole -- claim-then-commit is two statements and each needs its own CAS on
--    the version it read. Not a guard on title or start_date, which are
--    excluded on purpose (no server write overwrites them, so including them
--    would only make honest refinements lose a CAS for no reason).
--    RESIDUAL, ACCEPTED: a losing writer is told to retry, and nothing here
--    stops an unbounded retry loop in our own code -- refinements_used' 100
--    ceiling is still the backstop that turns that into a loud failure.
-- ============================================================================

commit;
