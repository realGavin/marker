# Development

"Letterboxd for golf courses" — map + log + bucket lists + grounded AI trip planner.
Golf is skin #1 of a niche-agnostic engine. Full design: [docs/architecture.md](docs/architecture.md). Working rules: [CLAUDE.md](CLAUDE.md).

## One-time setup

1. **Xcode** — install the full app from the Mac App Store (needed for the iOS simulator), then:

   ```bash
   sudo xcode-select -s /Applications/Xcode.app && sudo xcodebuild -runFirstLaunch
   ```

2. **Apple Developer Program** ($99/yr, can take days — start early): https://developer.apple.com/programs/enroll/
3. **Supabase** — create a free project at https://supabase.com, then copy `apps/mobile/.env.example` to `apps/mobile/.env` and fill in the URL + anon key from Project Settings → API. Never commit `.env`; never put service-role keys in it.
4. Later milestones: Cloudflare (R2), RevenueCat, Anthropic API key — not needed until M2/M6/M4.

## Daily commands

```bash
pnpm install        # after any dependency change
pnpm verify         # typecheck everything + engine-purity lint
cd apps/mobile && pnpm start   # Metro dev server
cd apps/mobile && pnpm ios     # build + run on iOS simulator (needs Xcode)
```

## Layout

- `apps/mobile` — the engine app (Expo). No niche vocabulary allowed (lint-enforced).
- `packages/core` — skin contract + domain types.
- `packages/skins/golf` — the golf skin: vocabulary, theme, attribute schema, curated lists.
- `tooling/etl` — course data pipeline (M1).
- `supabase/` — SQL migrations + RLS isolation tests.
