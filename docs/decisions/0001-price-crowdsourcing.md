# 0001 — Green-fee price bands by structured crowdsourcing (v1.1)

Status: accepted (v1.1 scope) — 2026-08-06

## Context

Green fees are the single most-requested fact we cannot ship. There is no free, licensable, nationwide source: rates are per-property, seasonal, day-of-week, and republished under terms we will not accept. Scraping booking sites is both a legal and a maintenance liability, and it violates the flat-cost rule the moment it needs babysitting.

Constraint 3 of the constitution (grounding) forbids inventing prices: the batch description job and the Trip Planner may never state a fee that is not a stored, sourced value. Today `attrs.greenFeeBand` is populated for a small minority of places, so most place pages show nothing at all where users expect a price signal.

Free-text price reports would solve coverage and create a moderation queue — the thing we are structurally unwilling to staff.

## Decision

Ship **structured crowdsourcing** in v1.1: users submit a coarse price *band* from a fixed four-value enum, never a number, never free text. Bands are aggregated and displayed only once three independent users agree, and are labelled as user-reported — never merged into `attrs.greenFeeBand`, which stays reserved for sourced data.

## Schema

```sql
create table public.place_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  place_id uuid not null references public.places (id) on delete cascade,
  kind text not null check (kind in ('green_fee_band')),
  value text not null check (value in ('$', '$$', '$$$', '$$$$')),
  created_at timestamptz not null default now(),
  unique (user_id, place_id, kind)
);

alter table public.place_reports enable row level security;

-- Write your own report, change your mind later. No select policy exists, so
-- raw rows are unreadable through the API: who reported what stays private.
create policy "place_reports: insert own" on public.place_reports
  for insert with check (auth.uid() = user_id);
create policy "place_reports: update own" on public.place_reports
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Aggregates only, and only once three users agree.
create view public.place_report_aggregates
with (security_invoker = false) as
  select
    place_id,
    kind,
    mode() within group (order by value) as value,
    count(*) as report_count
  from public.place_reports
  group by place_id, kind
  having count(*) >= 3;

revoke all on public.place_reports from anon, authenticated;
grant insert, update on public.place_reports to authenticated;
grant select on public.place_report_aggregates to anon, authenticated;
```

`kind` is an enum-by-check rather than a single-purpose table so v1.2 signals (walkability, pace) reuse the pipeline without a migration.

**Deviation from brief, deliberate:** the aggregate view is `security_invoker = false` (definer), not invoker. With no select policy on the base table, an invoker view runs under the caller's RLS and returns zero rows for everyone — the aggregate would be permanently empty. Definer + `revoke all` on the base table is what actually delivers "aggregates public, raw rows private". The view is a pure aggregate over two non-sensitive columns and exposes no `user_id`, so it leaks nothing. If a future reviewer insists on invoker semantics, the equivalent is a `security definer` function with `search_path = ''` — same privilege posture, more ceremony.

If the log UI later needs to prefill a user's own previous band, add a `for select using (auth.uid() = user_id)` policy — own-row only. That is a strictly additive change and does not weaken the above.

## UI spec

- **Capture**: after a user marks a place played, the log flow shows one optional row — four band buttons plus a skip. One tap, no keyboard, no free text. Dismissible and never blocking; a user who ignores it forever sees no nag.
- **Display**: the place page renders a fact `Golfers report: $$` **only** when `place_report_aggregates` has a row (i.e. `report_count >= 3`). Below three, the fact is absent — no "1 report" states, no partial credibility. It renders as a distinct, attributed fact, visually separate from the sourced `Green fees` fact; if both exist, both show.
- **Trip Planner**: reported bands are **not** in the planner's retrieval context and never appear in prompt output as a price claim. The planner's no-price rule is unchanged. Rationale: a model-voiced "$$" reads as authority, while a labelled place-page fact reads as what it is — other users' opinion.
- **Copy**: user-facing strings live in the golf skin, not the engine. The engine renders a generic attributed-fact row.

## Consequences

- **Moderation-free by construction.** The only writable value is one of four enum members, so there is nothing to abuse beyond voting the wrong band — and the mode-of-three threshold absorbs that. No text, no images, no queue, no staffing.
- **Sparse at launch, and that is acceptable.** Three reports per place is a high bar early; expect near-zero coverage on day one and meaningful coverage only in dense metros. The feature costs nothing while empty, which is why it can ship before it is useful.
- **One row per user per place per kind**, enforced by the unique constraint, so no ballot stuffing without multiple accounts.
- **Reversible.** Dropping the view and table removes the feature entirely; no sourced data depends on it.
- Revisit at 50k reports: if the mode is unstable across seasons, add a recency window to the aggregate rather than a moderation layer.
