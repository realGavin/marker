const PAGE_CSS = `body { font-family: -apple-system, system-ui, sans-serif; max-width: 680px;
         margin: 0 auto; padding: 24px; color: #1A1A18; background: #FAF7F0; line-height: 1.6; }
  h1 { color: #1B4D3E; } h2 { color: #1B4D3E; margin-top: 28px; }
  a { color: #1B4D3E; }`;

/** Support page served at /support — App Store Connect requires a support URL. */
export const SUPPORT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Marker Golf — Support</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<h1>Marker Golf — Support</h1>
<p>Questions, bug reports, or a course listed wrong? Email
<a href="mailto:shuozeng21@gmail.com">shuozeng21@gmail.com</a> and you'll get a reply
from a real person — usually within a day or two.</p>

<h2>Common questions</h2>
<h3>A course is missing or has the wrong details</h3>
<p>Our directory is built from open map data, so a few of the 12,000+ courses
have gaps. Email the course name and city and we'll correct it.</p>

<h3>How do I cancel my subscription?</h3>
<p>Subscriptions are managed by Apple, not by us: on your iPhone open
Settings → tap your name → Subscriptions → Marker Golf → Cancel. Your Pro
features stay active until the paid period ends.</p>

<h3>I paid but Pro features are locked</h3>
<p>Open the paywall and tap "Restore purchase". If that doesn't work, email us
with the Apple ID email you purchased with.</p>

<h3>How do I delete my account?</h3>
<p>Profile → Delete account. This removes your account and everything in it
immediately and permanently.</p>

<h3>How does trip sharing work?</h3>
<p>Open a trip, tap Invite, and share the 6-letter code. Anyone with the code
can open Trips → Join a trip and enter it to view and edit that trip with you.</p>

<h2>Privacy</h2>
<p>See our <a href="/privacy">privacy policy</a>. No ads, no tracking, no data sales.</p>
</body>
</html>`;

/** Privacy policy served at /privacy — required by App Review, hosted flat-cost. */
export const PRIVACY_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Marker Golf — Privacy Policy</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<h1>Marker Golf — Privacy Policy</h1>
<p><em>Effective July 28, 2026</em></p>

<p>Marker Golf ("the app") is built to store as little about you as possible.
This page explains exactly what we collect and why.</p>

<h2>What we collect</h2>
<ul>
<li><strong>Account:</strong> your email address (or your Apple ID token if you use
Sign in with Apple), a username you choose, and an optional home state.</li>
<li><strong>Your content:</strong> the courses you log, ratings, notes, lists,
trips, and scheduled tee times you create. This is the product — it exists so
the app can show it back to you and, where you explicitly share a trip invite
code, to people you invite.</li>
<li><strong>Purchases:</strong> subscription status is processed by Apple and
RevenueCat. We never see or store your payment details.</li>
</ul>

<h2>What we don't do</h2>
<ul>
<li>No advertising, no ad trackers, no analytics SDKs that profile you.</li>
<li>No selling or sharing of your data with data brokers — ever.</li>
<li>No tracking across other companies' apps or websites.</li>
<li>Your precise location is used only on your device to show nearby courses
when you tap "near me" or a distance filter; it is never uploaded or stored.</li>
</ul>

<h2>Where your data lives</h2>
<p>Your account and content are stored with Supabase (hosted PostgreSQL) with
row-level security, meaning the database itself only ever returns your rows to
you. Course photos and maps are public, static data served from Cloudflare.</p>

<h2>AI features</h2>
<p>When you use the Trip Planner, your trip request (region, days, preferences)
is processed by Anthropic's Claude API to compose an itinerary from our own
course directory. Your request is not used to train models.</p>

<h2>Deleting your data</h2>
<p>Profile → Delete account permanently removes your account and all your
content immediately. No email required, no waiting period.</p>

<h2>Contact</h2>
<p>Questions: <a href="mailto:shuozeng21@gmail.com">shuozeng21@gmail.com</a></p>
</body>
</html>`;
