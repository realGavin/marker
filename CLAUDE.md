# Marker — project constitution

"Letterboxd/AllTrails for golf courses" (working title Marker). Golf is skin #1 of a niche-agnostic engine. Full design: `docs/architecture.md`. Decisions log: `docs/decisions/`.

## Non-negotiable constraints
1. **Engine purity**: engine code (`apps/mobile`, `packages/core`) must never contain niche vocabulary (golf/course/played/…). Skins (`packages/skins/*`) own vocabulary, theme, attribute schemas, curated seeds, prompts. Enforced: `pnpm lint:purity`.
2. **Flat infra cost**: no metered map/places/geocoding APIs, ever. Basemap = self-hosted PMTiles on Cloudflare R2. Course pins = static JSON + on-device clustering.
3. **AI cost ≈ zero per user**: descriptions/embeddings are one-time batch jobs. The ONLY live per-user AI is the Trip Planner (Claude Haiku, subscriber-gated, fair-use capped) and it must be grounded: retrieve real candidates from DB → model picks by ID → server validates IDs → client renders from DB rows. No price claims unless a stored green-fee band exists.
4. **Strict isolation**: every user table has RLS; entitlements written only by RevenueCat webhook; secrets only in server-side env (never in the app bundle, never in chat).
5. **Stay in lane**: no GPS rangefinder, no hole-by-hole data, no licensed scorecards, no tee-time booking.

## Layout
- `apps/mobile` — Expo (SDK 57) + expo-router; THE ENGINE. Dev build required (MapLibre native module) — Expo Go won't work from M2 on.
- `packages/core` — skin contract + domain types.
- `packages/skins/golf` — golf skin (config/data only, no app logic).
- `tooling/etl` — course data pipeline (OSM/Overture → Postgres).
- `supabase/` — SQL migrations (RLS policies live with the tables).
- `scripts/` — repo tooling (purity lint).

## Commands
- `pnpm install` (root) — hoisted node-linker (see .npmrc), required for Metro.
- `pnpm verify` — typecheck all packages + engine-purity lint. Run before considering any task done.
- `cd apps/mobile && pnpm start` — Metro; `pnpm ios` — build+run simulator (needs full Xcode).

## Build gotchas (learned)
- Repo home is `/Users/gavinzeng/Projects/marker`. It must stay OUT of iCloud-synced folders (Desktop/Documents): iCloud stamps FinderInfo on build outputs mid-build → codesign fails with "resource fork/detritus" errors. (Moved off Desktop 2026-07-25 for this reason.)
- Expo's `run:ios` demands a signing certificate even for simulator builds (Sign-in-with-Apple capability); use `xcodebuild ... CODE_SIGNING_ALLOWED=NO` + `simctl install/launch` instead.
- Deleting `ios/build` also deletes ReactCodegen outputs; re-run `pod install` after purging it.
- `pod install` / `expo run:ios` deadlock inside the Claude Code shell sandbox (CocoaPods' Node helper subprocess gets blocked; ruby hangs on a pipe read at "Installing CocoaPods"). Run iOS native build commands with the sandbox disabled.
- Homebrew pnpm requires Node 22+; this machine uses Node 20 + corepack-pinned pnpm 10 (`packageManager` field).
- Always run `expo`/`pod` non-interactively in background shells (`CI=1`), and `cd` explicitly in every background command — background shells start fresh.

## Conventions
- TypeScript strict; zod at all data boundaries.
- Engine reads all niche content via the active `Skin` (see `packages/core/src/skin.ts`); the single skin injection point is `apps/mobile/src/skin.ts`.
- User-facing copy in the engine must come from `skin.vocab` or be niche-neutral.
- DB naming is generic: places, place_logs, lists — never niche terms.
- Milestones M0–M8 (docs/architecture.md §4); demo definition-of-done to Gavin at each boundary before advancing.

## Workflow with Gavin
Plain English, explain jargon on first use, give exact runnable commands in ```bash blocks, never ask him to paste secrets into chat (point to .env files instead).
