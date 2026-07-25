# Architecture + Build Game Plan — "Place Engine" (Skin #1: Golf)

## Context

Greenfield consumer iOS app: a "Letterboxd / AllTrails for golf courses" — map, directory, personal log, bucket lists, shareable profile card, and an AI trip planner grounded in real course data. Built by a solo developer whose priorities are: real profit, near-zero ongoing maintenance, flat infrastructure cost as users grow, and a niche-agnostic engine so golf is only the first "skin." No app code exists yet; the project will live in `/Users/gavinzeng/Desktop/Marker` (empty folder, created today — assumed to be the intended home and working title; confirm in Decisions below).

This document is the deliverable for approval. No files or code are created until approved.

---

## 1. What I understood + assumptions

**Understood:** A log/map/light-social app, explicitly NOT a GPS rangefinder or scorecard app. Engine (generic: places, logs, lists, profiles, trips) is strictly separated from skin (golf vocabulary, data, theme, curated lists). Costs must stay flat with user growth: no metered map SDKs, no metered places APIs, no per-user AI except the subscriber-gated Trip Planner, which must be grounded so it cannot invent courses or prices. iOS first, cross-platform codebase, freemium via subscription.

**Assumptions (flag if wrong):**
- Project directory = `/Users/gavinzeng/Desktop/Marker`; "Marker" is the working title (App Store name decided later).
- MVP geography = United States course data (best open-data quality, your launch market), with a worldwide basemap so the map never looks broken abroad. International course data is a fast-follow.
- "Light social" in MVP = shareable profile card image only. No follow graph, feeds, or comments (those add moderation burden, which conflicts with low-maintenance).
- "Trip Recommendor" (listed separately from Trip Planner) = a zero-AI-cost inspiration surface: precomputed/curated trip templates ("Scottsdale long weekend") + nearby-to-you suggestions. The Planner is the live-AI custom itinerary. This split is deliberate: Recommendor is free-tier bait, Planner is the paid feature.
- No tee-time booking, no user photos in MVP (photos = storage cost + moderation; deferred to v1.1 — see Decisions).
- You have or will get an Apple Developer account and are willing to spend roughly $10–30/month on infrastructure at launch.

---

## 2. Tech stack + data approach

I adopt all of your validated defaults. Refinements are marked ✦.

| Choice | Rationale |
|---|---|
| **Expo (React Native) + TypeScript** | One codebase, iOS-first now / Android later; Expo's build service (EAS) handles iOS signing pain for a solo dev. |
| ✦ **Expo "development build," not Expo Go** | The MapLibre native module isn't available inside the Expo Go sandbox app; a dev build is a custom version of the app with the module compiled in. Minor workflow difference, decided up front to avoid a mid-project surprise. |
| **Supabase** (Postgres + PostGIS + pgvector, Auth, Edge Functions) | One vendor covers database, geospatial queries (PostGIS = map/location extension for Postgres), vector search (pgvector = similarity search extension), sign-in, and serverless API code. Free tier → $25/mo Pro; pricing is by instance size, not per user — satisfies the flat-cost constraint. Postgres is portable if we ever leave. |
| **MapLibre (open-source map renderer)** | No Mapbox/Google SDK = no per-map-load billing, ever. |
| ✦ **Basemap: Protomaps PMTiles file on Cloudflare R2** | PMTiles = the entire world's base map packed into one static file (~100 GB planet, or ~a few GB for a lower-detail build); R2 = Cloudflare's file storage with **zero bandwidth charges**. Result: world map for ~$1–2/month flat regardless of user count. No tile server to maintain. |
| ✦ **Course pins: static JSON + client-side clustering** | ~16k US courses is only a few MB. Ship/CDN-cache one JSON file; the phone clusters pins itself (supercluster library). Zero queries per pan/zoom, works offline, flat cost. |
| **Course data: bulk-seeded from OpenStreetMap + Overture** (both open datasets) | One-time ETL (extract-transform-load = scripted data import) instead of a metered places API. We own the data in our Postgres, can correct it, and re-run the pipeline for niche #2. |
| ✦ **Course descriptions: one-time batch LLM generation** | Generate every description offline with the Claude Batch API (50% discount), fed ONLY structured facts we hold (location, holes, type, elevation, nearby town). One-time cost roughly tens of dollars, then $0/user forever. |
| ✦ **Embeddings precomputed into pgvector** | Powers "similar courses" and semantic finder ("links-style courses near the coast") with zero live LLM calls. One-time batch cost. |
| **Trip Planner: Claude Haiku 4.5 via a Supabase Edge Function** | The only live per-user AI. Haiku costs ~$0.01 per plan; gated behind the subscription plus a fair-use cap, so AI spend is a small % of revenue by construction. API key lives server-side only. |
| **RevenueCat** | Subscription plumbing + receipt validation + paywall A/B testing without app updates. Free until ~$2.5k/month revenue — a problem you want to have. |
| ✦ **Share card rendered on-device** (react-native-view-shot) | The "my golf map" card is drawn as a native view and snapshotted to an image on the phone. Zero server rendering, zero cost, works offline. |
| **Monorepo with pnpm workspaces** | One repository holding the app + skin packages + ETL scripts, so engine/skin separation is enforced by package boundaries, not discipline. |

**Deviations from your defaults:** none rejected — only made concrete (PMTiles+R2 for tiles, client-side clustering, batch-precomputed descriptions/embeddings, on-device share card).

---

## 3. High-level architecture

### 3.1 Engine vs. skin

```
marker/  (monorepo)
├── apps/mobile            # THE ENGINE — 100% niche-agnostic code
├── packages/core          # shared types, entitlement logic, validation
├── packages/skins/golf    # THE SKIN — config + data only, no app logic
│   ├── skin.config.ts     # vocabulary map: "place"→"course", "logged"→"played"…
│   ├── theme.ts           # colors, fonts, icons
│   ├── attributes.ts      # niche attribute schema (holes, par, course type…)
│   ├── prompts/           # Trip Planner prompt templates (golf phrasing)
│   ├── seeds/             # curated lists (Top 100 Public, Bucket List Majors venues…)
│   └── map-style.json     # basemap style (golf-green palette)
└── tooling/etl            # data pipeline (per-niche adapters, shared core)
```

**The rule that keeps this honest:** engine code may never contain the words golf/course/played/round. It renders `skin.vocab.place`, validates `attrs` against `skin.attributeSchema`, themes from `skin.theme`. A new niche (disc golf, ski resorts, surf breaks, national parks) = new skin package + ETL adapter + new App Store listing. Same engine binary logic, separate app per niche.

CI (a lint script at first) greps engine code for banned niche words to enforce the boundary mechanically.

### 3.2 Conceptual data model (Postgres, all user tables protected by RLS)

*RLS = Row Level Security: the database itself refuses to return rows that don't belong to the requesting user — isolation enforced even if app code has a bug.*

- **profiles** — user id, handle, display name, home region, avatar choice.
- **places** — id, niche, name, lat/lng (PostGIS point), city/state/country, `attrs` JSONB (niche-specific facts, validated against the skin's schema), description (precomputed), embedding (pgvector), slug, data-source provenance. Public read-only.
- **place_logs** — user, place, status (`played` | `want`), rating (0–10 half steps), note, date. The heart of the app. One row per user×place.
- **lists** — id, owner (`system` for curated, or a user), title, description. **list_items** — list, place, position. Progress ("37/100") is computed by joining list_items × the user's logs — never stored, never stale.
- **entitlements** — user, tier, expiry; written only by the RevenueCat webhook (server-to-server), read by clients. Client never self-reports "I'm premium."
- **trip_plans** — user, structured request, resulting itinerary JSON (course IDs + text), created_at. Saved plans are re-viewable for free — no repeat AI cost.

### 3.3 How the Trip Planner cannot hallucinate

Retrieval-first, validate-after — the model can only choose, never invent:

1. **Parse** — user's free-text trip ("5 days in Scottsdale in March, 4 rounds, mid budget, prefer walkable") → structured constraints. Cheap single Haiku call with a strict JSON schema.
2. **Retrieve** — our code (not the LLM) runs PostGIS + pgvector queries to pull 15–40 real candidate courses matching region/prefs from OUR database.
3. **Compose** — Haiku receives ONLY those candidates as JSON (id, name, facts) and must return an itinerary as JSON referencing candidate IDs, with routing/pacing/reasoning text. System prompt forbids outside knowledge of courses or any price claims.
4. **Validate** — server checks every returned ID against the candidate set; any unknown ID is dropped and the day is repaired or the plan regenerated. Price text is only allowed if we have a green-fee band stored; otherwise the field is omitted entirely.
5. **Render** — client draws the itinerary from validated IDs, linking each stop to its real course page.

A fake course is structurally impossible to display: the client renders from database IDs, not model prose. Fair-use cap ~20 plans/month per subscriber keeps worst-case AI cost under ~$0.25/user/month against a ~$4–6/month subscription.

### 3.4 Runtime picture

```
iPhone (Expo app)
 ├─ MapLibre ──► PMTiles basemap on Cloudflare R2 (static, $~1/mo flat)
 ├─ course pins ◄─ static JSON (CDN-cached), clustered on-device
 ├─ Supabase client ──► Auth, places, logs, lists (RLS-guarded)
 ├─ Edge Function "plan-trip" ──► retrieval → Claude Haiku → validation
 └─ RevenueCat SDK ──► App Store billing; webhook ──► entitlements table
Offline batch (your laptop, occasional): ETL seeding · description generation · embeddings
```

Steady-state moving parts to maintain: **Supabase + one static file host**. That's the whole ops surface.

---

## 4. Milestones to a shippable iOS MVP

Ordered; each ends at a stable, demoable checkpoint. Data (M1) comes before map UI (M2) because every later feature depends on real course rows. Rough solo pace: M0–M2 ≈ weeks 1–3, M3–M5 ≈ weeks 4–6, M6–M8 ≈ weeks 7–9.

**M0 — Foundations.** Monorepo scaffold; Expo app with dev build running on simulator; Supabase project; Sign in with Apple + email auth; profile creation; skin interface defined and golf skin stub wired; engine-purity lint. *Done when:* app runs on the iOS simulator, a user can sign up/in/out, profile row is created, RLS proven by a failing cross-user read test, and the engine contains zero golf strings.

**M1 — Course data engine.** ETL pipeline: pull OSM + Overture golf features, merge/dedupe, spatial-join city/state, load `places`. Data quality report. *Done when:* ≥95% of a 50-course ground-truth checklist (famous + local + tiny courses) exists with correct name and location; pipeline reruns idempotently with one command.

**M2 — Map + finder.** Self-hosted basemap live on R2; clustered course pins from static JSON; search by name and by place; "near me"; course detail page (facts from `attrs`, description placeholder). *Done when:* smooth pan/zoom over the whole US on-device, search returns any known course, and a network inspector shows **zero** calls to metered map/places APIs.

**M3 — Logging + lists.** Played/want-to-play with rating + note; My Courses views; user lists; curated starter lists seeded from the skin (e.g. Top 100 Public); progress bars ("37/100"). *Done when:* full log→list→progress loop works, survives offline/relaunch, and curated list progress updates the moment a course is logged.

**M4 — Descriptions + similarity (batch AI).** Batch-generate all course descriptions from stored facts; batch embeddings; "similar courses" module on detail pages; semantic finder query. *Done when:* 100% of courses have a description; a 30-course audit shows zero invented facts; total generation cost logged (expect tens of dollars, one-time).

**M5 — Share card.** On-device "my golf map" card: pin map of played courses + count + top-rated; native share sheet. *Done when:* a fresh user can go played-3-courses → attractive shareable image in under 2 minutes.

**M6 — Monetization.** RevenueCat integration, paywall, entitlement gates (free: unlimited logging, 3 personal lists, share card, 1 trial trip plan; Pro: unlimited lists, stats, unlimited planner, offline map area packs). Sandbox purchase testing. *Done when:* sandbox purchase/restore/expiry all flip features correctly, enforced server-side via the entitlements table.

**M7 — Trip Planner + Recommendor.** The grounded pipeline from §3.3 as an Edge Function; planner UI (structured form + free-text); saved plans; Recommendor: 10–15 precomputed curated trip templates + nearby suggestions. *Done when:* 20 diverse test prompts yield zero non-database courses and zero price claims, p95 latency < 15s, malformed model output degrades gracefully.

**M8 — Hardening + App Store.** Empty/error/loading states; onboarding polish; privacy policy + App Privacy labels; App Store assets; TestFlight beta with 5–10 golfers; fix; submit. *Done when:* approved and live on the App Store.

Post-MVP backlog (not built now): photos on logs, Android, international courses, web profile pages/deep links, follow graph, niche #2 dry run.

---

## 5. Build orchestration (subagents, config, memory)

I orchestrate; specialists execute; a reviewer gates merges. Top models only where design quality compounds (schema/security/AI grounding); cheaper models for routine screens and scripts.

| Agent | Role | Model |
|---|---|---|
| `architect` (me, main session) | Decisions, task breakdown, integration, milestone sign-off | Fable |
| `backend-engineer` | Supabase schema, migrations, RLS policies, Edge Functions | Opus (design) / Sonnet (routine) |
| `mobile-engineer` | Screens, navigation, map UI, share card | Sonnet |
| `data-engineer` | ETL pipeline, dedupe, data-quality reports, batch jobs | Sonnet |
| `ai-engineer` | Planner prompts, retrieval tuning, grounding validator + eval set | Opus |
| `reviewer` | Code review every milestone: RLS correctness, engine purity, cost leaks (any metered API), error handling | Opus |
| `release-ops` | Store copy, privacy labels, EAS/TestFlight configs, docs | Haiku |

Config/memory set up at M0 (after approval):
- `CLAUDE.md` — project constitution: constraints (engine purity, flat cost, no rangefinder features), commands, layout.
- `docs/architecture.md` (this design, maintained) + `docs/decisions/` — one-page ADRs (Architecture Decision Records — short "what we chose and why" notes) for irreversible choices.
- `.claude/agents/*.md` — the agent definitions above, so behavior is consistent across sessions.
- Persistent memory entries for your preferences (plain English, exact commands, approval-gated steps) and project facts.

Workflow per milestone: I brief agents → parallel execution where independent → reviewer pass → I integrate and verify the Definition of Done with you → next milestone. You approve at milestone boundaries, not per-file.

---

## 6. Prerequisites checklist (what to install / create, and why)

Accounts (all have free tiers unless noted):
1. **Apple Developer Program** — $99/yr — required to put anything on TestFlight/App Store. Enrollment can take days: **start first**. https://developer.apple.com/programs/enroll/
2. **Supabase** — database/auth/functions. Free tier to start.
3. **Cloudflare** — R2 file storage for the basemap. ~$1–2/mo.
4. **Expo (EAS)** — cloud iOS builds + TestFlight submission. Free tier is enough initially.
5. **RevenueCat** — subscriptions. Free at our scale.
6. **Anthropic API key** (console.anthropic.com) — batch descriptions/embeddings + Trip Planner. Pay-as-you-go; expect tens of dollars one-time, near-zero monthly until M7.
7. **GitHub** — code backup/versioning. Free.

Local tools — run these (I'll verify versions at M0):

```bash
xcode-select --install
```

```bash
brew install node pnpm watchman cocoapods
```

Plus **Xcode from the Mac App Store** (full app, not just command-line tools — needed for the iOS simulator). Keys/secrets: don't paste any API keys into chat; at M0 I'll set up a `.env` pattern and tell you exactly where to put each one yourself.

---

## 7. Decisions I need from you (recommended default in bold — silence = default)

1. **Project home + working title** — **`/Users/gavinzeng/Desktop/Marker`, working title "Marker"** (App Store name chosen at M8; golf skin may ship under a golf-flavored brand).
2. **MVP course-data geography** — **US only** (best open-data quality, your market, faster QA; worldwide basemap regardless; international courses fast-follow).
3. **Pricing** — **$5.99/mo and $39.99/yr with 7-day free trial on annual** (impulse-priced for an affluent niche; annual-first presentation; easy to A/B later via RevenueCat).
4. **Photos on logs** — **defer to v1.1** (avoids storage growth + content moderation at launch; notes/ratings carry the MVP).
5. **Social scope** — **share-card image only; no follow graph in MVP** (zero moderation burden; strongest viral artifact anyway).
6. **Trip Planner model** — **Claude Haiku 4.5** (~$0.01/plan; upgrade path to Sonnet if quality demands).
7. **Backend hosting** — **Supabase cloud** (free → $25/mo Pro), not self-hosted (your time is the scarcest resource; Postgres keeps us portable).

---

## 8. Product design: features + user flow

**Structure — 4 tabs:** **Map** (home: the world of courses, search bar, "near me"), **Lists** (curated + personal, progress bars), **Log** (my played/want collection + stats teaser), **Profile** (identity, share card, trips, settings/paywall). Trip Planner lives inside a "Trips" entry on Profile + a promoted card on Map.

**First-run flow:** Splash → Sign in with Apple (one tap) → pick home region → "Mark a few courses you've played" quick-add (instant collection = instant investment) → land on Map centered home with pins and their played markers already colored in.

**Core loop (free):** Open map → spot/search a course → detail page (facts, description, similar courses) → log it (played + rating + note, or want-to-play) → watch curated-list progress tick up ("38/100 Top Public") → share the card when it looks impressive.

**Upgrade moments (paywall shown in context, never at launch):** creating a 4th personal list; tapping stats; requesting a 2nd trip plan; tapping offline maps.

**Trip Planner flow (Pro):** "Plan a trip" → structured form with free-text extras (region, dates, rounds, budget band, preferences) → grounded pipeline (§3.3) → day-by-day itinerary of real course cards with reasoning → save/share; every stop taps through to its course page and can be added to want-to-play.

**Design language:** clean, editorial, collector-feel (Letterboxd energy, not sports-app energy) — deep green/cream palette from the skin theme, card-based layouts, heavy on the map as identity. All copy through the skin vocabulary so niche #2 is a re-skin, not a rewrite.

---

## Verification (how we'll know it works, per the constraints)

- **Flat cost:** network audit at M2/M8 proves zero metered map/places calls; monthly bill target < $30 pre-revenue.
- **Grounding:** M7 eval suite (20+ prompts) must show zero non-database courses and zero price claims before ship.
- **Isolation:** automated cross-user read/write tests against RLS at M0 and every schema change.
- **Engine purity:** lint greps engine packages for niche vocabulary in CI.
- **End-to-end:** every milestone's Definition of Done is demonstrated on the iOS simulator before we advance.
