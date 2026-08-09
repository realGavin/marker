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
trips, and scheduled tee times you create. This is private by default — it
exists so the app can show it back to you.</li>
<li><strong>What you choose to share:</strong> a trip you share by invite code is
visible to whoever you give the code to. A trip you <em>publish</em>, and any
course condition report you file, is visible to everyone, shown next to your
username. Your numeric course ratings are never shown individually — they only
appear inside a course's average, and only once at least three people have
rated it. Nothing is shared until you take one of those actions.</li>
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
content — including anything you published — immediately. No email required,
no waiting period. You can also unpublish a trip or delete a single condition
report at any time without deleting your account.</p>

<h2>Contact</h2>
<p>Questions: <a href="mailto:shuozeng21@gmail.com">shuozeng21@gmail.com</a></p>
</body>
</html>`;

/** Terms of use served at /terms — required for user-generated content (App Review Guideline 1.2). */
export const TERMS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Marker Golf — Terms of Use</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<h1>Marker Golf — Terms of Use</h1>
<p><em>Effective August 7, 2026</em></p>

<p>By using Marker Golf, you agree to these terms. We've kept them short and
honest because you're the one using the app.</p>

<h2>What Marker is</h2>
<p>Marker is a directory and planning tool for golf courses. You can log courses
you've played, rate them, plan trips, and share that information with friends
via an invite code. Marker is <strong>not</strong> a booking service — we don't
reserve tee times, process payments, or speak for golf courses.</p>

<h2>Your content</h2>
<p><strong>You own what you post.</strong> Any course condition report, trip
note, or list you create is yours. When you post it, you grant us a license to
display it in the app and on our public directory for as long as the content
exists.</p>

<p><strong>Keep it respectful.</strong> Don't post content that is:</p>
<ul>
<li>Abusive, threatening, or harassing toward any person.</li>
<li>Impersonating someone else.</li>
<li>Spam, promotional, or commercial.</li>
<li>Illegal or encouraging illegal activity.</li>
<li>Otherwise objectionable or offensive.</li>
</ul>

<p>Violation of these rules may result in your content being removed or your
account being suspended.</p>

<h2>Reporting content</h2>
<p>If you see content that violates these terms, report it in the app — tap the
content and select Report. Reports are reviewed and acted on within 24 hours.
We take abuse seriously: accounts that repeatedly post objectionable content
are removed.</p>

<h2>Course data</h2>
<p>Marker's course directory comes from open map data. We've done our best to
keep it accurate, but we can't guarantee that every course detail is correct.
If something is wrong, email <a href="mailto:shuozeng21@gmail.com">shuozeng21@gmail.com</a>
and we'll fix it.</p>

<h2>Subscriptions</h2>
<p>Pro features are a subscription billed by Apple. You manage your subscription
in iOS Settings → tap your name → Subscriptions. We never see or store your
payment details.</p>

<h2>No warranty</h2>
<p>The app is provided as-is. We make no guarantees that it will work the way
you expect or that it won't break tomorrow. That said, we really do try to keep
it solid.</p>

<h2>Contact</h2>
<p>Questions or concerns? Email <a href="mailto:shuozeng21@gmail.com">shuozeng21@gmail.com</a>.</p>
</body>
</html>`;
