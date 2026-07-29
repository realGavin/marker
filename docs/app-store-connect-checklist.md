# App Store Connect — everything the Distribution page needs

Companion to `store-listing.md` (marketing copy). This file covers the
mechanical fields: screenshots, the App Privacy questionnaire, and URLs.

---

## 1. Previews and Screenshots

**Upload these six, in this order** — `docs/store-screenshots/final/`:

| Order | File | Caption baked into image |
|---|---|---|
| 1 | `01-map.png` | Every course, one map |
| 2 | `02-preview.png` | Tap a pin, log a round |
| 3 | `03-course.png` | Rate it. Remember it. |
| 4 | `04-profile.png` | Share your golf map |
| 5 | `05-itinerary.png` | Plan trips with friends |
| 6 | `06-lists.png` | Chase the bucket lists |

- All are **1290 × 2796** = the required **iPhone 6.9" Display** size.
- Only the 6.9" set is required; App Store Connect auto-scales it to every
  smaller iPhone. Do **not** upload iPad sizes — `supportsTablet` is false.
- Min 1, max 10 per size. The first two are what most people actually see.
- **App Preview (video) is optional** — skip for 1.0. If added later: 15–30s,
  886×1920 or 1080×1920 for 6.9", captured on-device, no device frames.

Raw uncaptioned captures are kept in `docs/store-screenshots/` if you ever
want to recompose. Regenerate captions with:
`cd tooling/etl && node src/store-shots.mjs`

---

## 2. App Privacy → Data Collection

**Tick exactly these four. Leave everything else unchecked.**

| Section | Data type | Why it applies |
|---|---|---|
| Contact Info | **Email Address** | Account sign-in |
| User Content | **Other User Content** | Logs, ratings, notes, lists, trips, tee times |
| Identifiers | **User ID** | Your handle + the account ID passed to RevenueCat |
| Purchases | **Purchases** | Subscription status via RevenueCat |

### Follow-up answers ASC asks for each one

For **all four**: *Used for tracking?* → **No.** *Linked to the user's
identity?* → **Yes** (everything hangs off the account).

Purposes:
- Email Address → **App Functionality**
- Other User Content → **App Functionality**
- User ID → **App Functionality** + **Analytics**
- Purchases → **App Functionality** + **Analytics**

The **Analytics** box on the last two is not optional — RevenueCat requires it
because their dashboard (customer history, charts) processes that data. Their
docs: "All RevenueCat users must select the Analytics and App Functionality
options for Purchase History."

### Why the tempting ones are NOT ticked

- **Precise / Coarse Location** — GPS is read on-device to centre the map and
  run the distance filter, and is never transmitted or stored. Apple defines
  "collect" as transmitting off-device, so this is correctly excluded.
  *(Judgment call flagged below.)*
- **Search History** — course search runs entirely against the bundled
  offline file; nothing is sent to a server.
- **Product Interaction / Crash Data / Performance Data** — there is no
  analytics or crash SDK in the app at all. Verified against `package.json`.
- **Device ID** — only required if you use ad-network integrations (IDFA).
  You don't.
- **Name** — the app never asks for a real name; Sign in with Apple requests
  the email scope only.

### One judgment call for you to confirm

Onboarding stores your **home state** (e.g. "CA") on the server. That is a
self-entered preference, not measured device location, which is why it's filed
under account data rather than Coarse Location — the standard reading, and how
comparable apps treat a "home region" field. If you'd rather be maximally
conservative, tick **Coarse Location** as well (App Functionality, linked, no
tracking); it costs nothing on the public label. Your call — say the word and
I'll note it as decided.

---

## 3. Other required fields on the version page

| Field | Value |
|---|---|
| Support URL | `https://marker-tiles.shuozeng21.workers.dev/support` |
| Privacy Policy URL | `https://marker-tiles.shuozeng21.workers.dev/privacy` |
| Marketing URL | leave blank (optional) |
| Copyright | `2026 Gavin Zeng` |
| Version | `1.0.0` |
| Category | Primary **Sports**, Secondary **Travel** |
| Age Rating | 4+ (answer "None" to every content question) |
| Sign-In Required | **Yes** → provide the demo account below |
| Contact Info | your name, phone, email — reviewer contact only, not public |

Name, subtitle, keywords, description, promotional text: copy from
`store-listing.md`.

### Demo account (App Review Information)
Required because the app is behind sign-in. Create a throwaway account in the
app, log 3–4 courses so it doesn't look empty, then put those credentials in
the demo account fields. Do **not** use your real account.

---

## 4. Still blocking submission

1. **Subscriptions must be created and attached** — App Store Connect →
   Subscriptions → group "Marker Pro" → `marker_pro_monthly` ($5.99) and
   `marker_pro_annual` ($39.99 + 7-day intro trial). First submission must
   include them for IAP review.
2. **Paid Apps agreement signed** (Business → Agreements) or products never
   appear, in TestFlight or production.
3. **Small Business Program** enrollment — 15% instead of 30% commission.
4. **Sandbox purchase verified** on the new build with the `appl_` key.
