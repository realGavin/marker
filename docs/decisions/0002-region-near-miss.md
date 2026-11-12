# 0002 — A typed region is disambiguated at input, not guessed at resolution

Status: accepted — 2026-08-28. Shipped in `6adc654` (region picker) and `7671249` (typo-tolerant suggestions).

## Context

`resolveRegion()` in `supabase/functions/plan-trip/index.ts` turns a typed region into a centre, exact city match first: every place whose `city` matches the string, grouped by state, largest group wins, median of that group is the centre.

The eval's geographic region check (`e4aa875`) found the case that forced this decision. A user typing **"Scotsdale"** gets an exact match on Scotsdale, Jefferson County, **Missouri** — a village where we hold one course — and is planned a trip **1,988 km** from **Scottsdale, Arizona**, where we hold 33 courses and which is almost certainly what they meant. The lexical check that preceded the geographic one actively concealed it: the scheduled course's city string was "Scotsdale" and so was the asked-for region, so it read as in-region and stayed silent.

The obvious framing — *should an exact match on a tiny city lose to an edit-distance-1 match on a much larger one?* — carries an assumption worth naming: that the server must pick one of the two silently, and the only question is which. Both silent answers are defensible and both are wrong for somebody:

- **Exact wins.** The traveler who typed a real place gets that place. The traveler who made a typo gets a plan for a state they have never thought about, with no explanation and no way back except retyping and hoping.
- **Bigger near-miss wins.** The typo case is fixed. Anyone who genuinely wanted the Missouri village can no longer reach it, because the override has no off switch.

Whichever the server picks, the wrong half of users get no signal, and neither do we: `resolveRegion` returns `{ lat, lng }` and every trace of the fork is gone by the time anything else runs.

## Decision

**`resolveRegion` keeps exact-match precedence. No typo-distance heuristic reorders the resolution. The ambiguity is resolved before the request is ever made, by the person who knows the answer.**

The region field is a **picker** over the same offline city/state index the map search uses (`apps/mobile/src/lib/pins.ts`), with a **fuzzy fallback** so a misspelling still surfaces the right place. Typing "Scotsdale" offers Scotsdale MO, Scottsdale AZ and Scarsdale NY, and the traveler chooses. Free text still works for anything we do not index.

Two details make it correct rather than merely fuzzy:

- **Fuzzy runs only as a fallback**, when the exact/prefix pass left room under the per-kind cap, so correct input is never displaced or reordered.
- **A prominence gate**: a fuzzy candidate surfaces only if it is a bigger place than what the exact/prefix pass already found. This is what separates the two directions of the pair — the typo surfaces the bigger place, while typing "Scottsdale" correctly does not dredge up the obscure one. No course counts are shown to the user, per the earlier call that they are hard to be accurate about.

The picker sends the **bare city string**, not a "City, ST" label: `resolveRegion` has no comma parsing and its exact-match path compares the whole string, so a state suffix would break the very match it was meant to help. States send the two-letter code straight to the length-2 fast path.

## Why this layer

**It costs nothing.** Disambiguation at input time spends zero model tokens, zero plans and **zero requests**. A server-side prompt would at best spend a round trip; a client-side "did you mean" shown *over a returned plan* would be worse still, because the plan is already generated and the turn already claimed, so correcting our ambiguity would spend a second plan from the user's own fair-use cap (constraint 3, and the `declined` note: the meter does not run backwards).

**Nobody's threshold decides for anybody.** A ranked list of real options hands the fork to the one person who knows which they meant. A server-side rule — in either direction — changes the answer for everyone it applies to, including the users it gets wrong, and tells us nothing when it does.

**It is honest about what we know.** We know both places exist and we hold courses in both. We do not know which the traveler meant. A list of options says exactly that. A guess asserts something we cannot support, which is the same objection this codebase makes to a fluent unsourced price.

**It generalises past typos.** Portland is genuinely ambiguous between Oregon and Maine and both have courses; `REGION_FIXTURES` records that if the resolution ever flips, "the answer would be a decision about resolveRegion". A picker answers that case too, with no new machinery and no second threshold.

## Considered and rejected

**A typo-distance override inside `resolveRegion`** (let an edit-distance-1 name with a much larger place count outrank an exact match). Rejected: it is true by tuning rather than by construction, and there is no threshold in it this codebase could defend the way it defends the measured ones. The 33:1 ratio in the Scotsdale case is a fact about our *coverage*, not about the traveler's intent, and coverage moves every ETL run.

**A server-side `mode: "disambiguate"` response**, following the `mode: "declined"` precedent, returned from the resolve path before `claimTurn` so it would cost no tokens. Rejected as unnecessary once the picker existed: it solves the same problem one network round trip later, and it still has to pick thresholds for when to interrupt.

**A corpus-wide ambiguity measurement** to size those thresholds — enumerating every pair of city names within one edit across the whole `places` table and reporting the place-count ratio and the distance between their resolved centres, so the trigger set could be counted instead of guessed. Built, then dropped with the server-side prompt it existed to justify. Worth recording that the distance dimension was the interesting one: `places_near` retrieves within 140 km, so two readings closer than that produce overlapping candidate sets and picking "wrong" costs the traveler nothing. Only far-apart ambiguity can hurt anyone, and a rule tuned on edit distance and place count alone would have fired on all the harmless pairs too.

## What this cost to learn

**The picker alone did not fix it, contrary to what `6adc654` claimed when it shipped.** It helps people who type a correct prefix; it did nothing for a misspelling, which is the case that motivated it, because the search matched by prefix and substring and the typed string is not a substring of the correct spelling. Typing "Scotsdale" still offered only Scotsdale, Missouri. Running it on the simulator is what showed the difference, and `7671249` is the actual fix. A UI affordance that *looks* like it addresses a case is not evidence that it does.

## Performance

Measured rather than assumed, because the fallback runs per keystroke on the UI thread: first-letter buckets cut ~7,700 cities to a few hundred, a length window filters again, and the bounded edit-distance loop bails as soon as a row's cheapest cell exceeds the cap. **~2.4 ms baseline to ~3.2 ms with fuzzy engaged, worst single call 5.3 ms against a 16.7 ms frame.** Max distance scales with query length (1 for ≤6 characters, 2 for 7+) so a short query cannot match half the index. Map search shares the index and benefits too.

## Consequences

- **The server is unchanged, so the eval fixture is unchanged.** `tooling/eval/plan-trip-eval.mjs` posts region strings straight to the edge function and never goes through the picker, so `resolveRegion("Scotsdale")` still resolves to Missouri and `REGION_FIXTURES["scotsdale"]` is still correct as written. It remains the file's one `derived: true` entry — a regression pin, not an oracle.
- **Free text is still exact-match-wins, by design.** The picker permits free text for places we do not index, and `rehydrate` resolves an adopted trip's own stored city with no traveler present to ask. Anything reaching `resolveRegion` as raw text gets the unchanged rule. This is an accepted limit, not an oversight: the fix is placed where a person is available to answer.
- Suggestions are only as good as the index, which is built from our own pins. A city we hold no courses in cannot be suggested, so a traveler asking for a region we do not cover still relies on `region_not_found`.
- The prominence gate depends on pin counts, so suggestion ordering shifts as coverage grows. That is the intended behaviour — it tracks where we actually have courses — but it means the "Scotsdale" example is not a fixed guarantee, only the current true answer.
