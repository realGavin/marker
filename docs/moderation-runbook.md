# Moderation Runbook

Operational guide for reviewing and actioning user reports of objectionable content. Audience: solo operator with Supabase SQL editor access and service role key.

**All queries below require the Supabase SQL editor with the service role key.** Run them against the live database. They will not work with the read-only role.

---

## Where reports land

All user-reported content is written to `public.content_reports`. Each row contains:
- `id` (uuid, primary key)
- `created_at` (timestamp with timezone, automatically set)
- `reporter_id` (uuid, the account that filed the report; nullable if reporter deletes their account)
- `target_type` (text: `'trip'`, `'condition_report'`, or `'profile'`)
- `target_id` (uuid — points to a trip, a condition report, or an account's `profiles.id`)
- `reason` (text, up to 500 characters, user's explanation)
- `resolved_at` (timestamp, null while open)
- `resolution` (text, null while open — filled in when you close the report)

---

## See open reports

Run this query in the SQL editor to fetch the moderation queue:

```sql
select * from public.admin_open_content_reports;
```

Read the VIEW, never a hand-copied version of its query. The view resolves all
three target types (trip, condition report, profile) and computes
`target_deleted` across all three; an out-of-date copy pasted into this document
reported every profile report as already-deleted, which is exactly the kind of
error that makes an operator dismiss a real complaint.

This shows:
- When it was reported
- Why (the `reason` text)
- Who reported it (`reporter_handle`)
- Who created it (`author_handle`)
- What they created (`content_title` and `content_body`)
- Whether the content has been deleted already (`target_deleted`)

---

## View the reported content

### Trip

To see a reported trip:

```sql
select
  id,
  user_id,
  title,
  publish_title,
  publish_summary,
  published_at,
  itinerary
from public.trip_plans
where id = '<TARGET_ID from the report>';
```

The trip's details are in the result. `published_at` tells you if it's public; `null` means unpublished.

### Condition report

To see a reported condition report:

```sql
select
  id,
  user_id,
  place_id,
  kind,
  note,
  score,
  created_at,
  expires_at
from public.condition_reports
where id = '<TARGET_ID from the report>';
```

The reported condition is shown here. `score` is one of `'poor'`, `'ok'`, or `'good'`. `expires_at` tells you when it will stop appearing in the public feed.

---

## Decision guidance

### Delete if the content:
- **Threatens or harasses** a specific person or group
- **Impersonates** someone else
- **Is spam** or purely promotional
- **Describes illegal activity** or encourages harm
- **Is clearly abusive** with no other value

### Suspend the account if:
- **Multiple violations** — the account has filed/posted objectionable content more than once
- **Severe abuse** — threats, slurs, or targeted harassment

### Dismiss if:
- **It's a disagreement**, not a violation (e.g., "I don't like this trip's route")
- **It's marginal** and another moderator might disagree — when in doubt, err on the side of leaving it
- **Context matters** and the content looks OK in full (e.g., sarcasm, hyperbole)
- **Reporter has a pattern** of frivolous reports — after 2–3 frivolous ones, mark them dismissed

### When in doubt:
- Sleep on it. Come back in 4 hours.
- If still unsure after a day, **dismiss it** — false negatives are lower cost than false positives on speech.

---

## Delete a trip

Before deleting, capture any identifying details you need from the trip (author, dates, etc.) if you want to keep notes.

```sql
begin;
-- Mark the report as resolved
update public.content_reports
  set resolved_at = now(), resolution = 'trip_deleted'
  where id = '<REPORT_ID>';
-- Unpublish the trip (stops it appearing in the public feed)
update public.trip_plans
  set published_at = null
  where id = '<TARGET_ID>';
-- Optional: if you want to delete the trip entirely (not just unpublish it):
-- delete from public.trip_plans where id = '<TARGET_ID>';
commit;
```

Replace `<REPORT_ID>` with the report's `id` and `<TARGET_ID>` with the trip's `id` from the report row.

**Why unpublish instead of delete?** Unpublishing stops it appearing publicly and in feeds. Deleting it entirely also removes it from the author's history. Unpublish is usually the right choice; delete only if the trip is severe abuse or spam.

---

## Delete a condition report

Before deleting, capture the details (what it said, who reported it, etc.) if you want to keep notes.

```sql
begin;
-- Mark the report as resolved
update public.content_reports
  set resolved_at = now(), resolution = 'condition_removed'
  where id = '<REPORT_ID>';
-- Delete the condition report (it will stop appearing in the public summary)
delete from public.condition_reports
  where id = '<TARGET_ID>';
commit;
```

Replace `<REPORT_ID>` with the report's `id` and `<TARGET_ID>` with the condition report's `id`.

The condition report will drop out of the public feed immediately. Existing endorsements on it are also deleted (cascade).

---

## Suspend an account

Suspension prevents the account from:
- Publishing new trips
- Filing new condition reports
- Sending new friend requests

Suspension **does NOT**:
- Delete the account
- Change their handle or display name (see "profile reset" below if needed)
- Stop them ACCEPTING a friend request someone else sent them. This is deliberate:
  suspension gates outbound initiation, not answers to someone else's. A suspended
  account can't send requests, so anyone it can accept chose to ask it first. If
  you need the account genuinely inert rather than unable to publish or initiate,
  ban it at the auth layer (Dashboard -> Authentication -> user -> Ban).
- Unpublish their existing trips (do that separately if needed)
- Delete their condition reports (do that separately if needed)

To suspend:

```sql
begin;
-- Suspend the account
update public.profiles
  set content_suspended_at = now()
  where id = '<AUTHOR_ID>';
-- Close the report you acted on. Note this filters on target, NOT reporter:
-- filtering on reporter_id would close the reports this account FILED against
-- other people (destroying legitimate complaints from someone who is themselves
-- being suspended) while leaving the report you actually acted on open.
update public.content_reports
  set resolved_at = now(), resolution = 'account_suspended'
  where id = '<REPORT_ID>'
    and resolved_at is null;
commit;
```

Replace `<AUTHOR_ID>` with the account's `id` (the `author_id` from the queue) and
`<REPORT_ID>` with the `id` of the report you are acting on.

To **un-suspend** (if needed later):

```sql
update public.profiles
  set content_suspended_at = null
  where id = '<AUTHOR_ID>';
```

---

## Close a report

After you've decided to delete content or suspend an account, close the report:

```sql
update public.content_reports
  set resolved_at = now(), resolution = '<your action>'
  where id = '<REPORT_ID>';
```

Set `resolution` to one of:
- `'trip_deleted'` — the trip was deleted/unpublished
- `'condition_removed'` — the condition report was deleted
- `'account_suspended'` — the account was suspended
- `'dismissed'` — the report was reviewed and deemed acceptable
- Any other short text describing what you did

Replace `<REPORT_ID>` with the report's `id`.

---

## The 24-hour commitment

**Why:** Apple App Review Guideline 1.2 requires prompt moderation of user-generated content. "Prompt" is interpreted as 24 hours.

**What it means:**
- Check the queue at least once per day
- The deadline is 24 hours from when the report was FILED (`created_at`), not from
  when you happened to check. A report filed Tuesday 10:01am is due Wednesday
  10:01am — checking daily is the mechanism for meeting that, not the deadline
  itself. (An earlier version of this line described a 48-hour window; it was
  wrong, and this is the section you would show App Review.)
- If you're away, queue someone else to cover

**What counts:**
- Marking the report as resolved (closing it in the database)
- No reply to the user is required (there's no built-in feedback system yet)

**The flood cap:** The rate limiting in the schema caps each account at 20 reports per rolling hour, so the queue cannot be artificially flooded.

---

## Profile reports

Handles and display names are written by users and are visible to others, so they
are reportable. A report arrives with `target_type = 'profile'` and `target_id`
set to the account's `profiles.id`.

**Copy the offending text out BEFORE you change anything.** `content_reports`
stores only the target id, never a snapshot — once you reset the handle, there is
no record of what it said, and you will want it if the account escalates.

```sql
-- 1. capture what was reported (do this first, keep the output)
select id, handle, display_name, content_suspended_at
from public.profiles
where id = '<target_id>';
```

Then, in ONE transaction — suspension alone is not enough, because it does not
touch a handle that is already sitting in every friend's list:

```sql
begin;
update public.profiles
set handle = 'user_' || left(replace(id::text, '-', ''), 18),
    display_name = null,
    content_suspended_at = now()
where id = '<target_id>';

update public.content_reports
set resolved_at = now(), resolution = 'handle reset + suspended'
where target_type = 'profile' and target_id = '<target_id>' and resolved_at is null;
commit;
```

**Sharp edge:** A suspended account can still change its own handle and display_name, so if an offender reverses your reset, the next step is to ban the account at the Supabase authentication layer (Dashboard → Authentication → select the user → Ban). That is the only control that prevents further edits.

---

## If a user claims unfair action

A user may email saying their content was deleted or their account was suspended unfairly.

1. **Check the report** — run the open-reports query above and filter for their content (include resolved reports by removing `where r.resolved_at is null`)
2. **Review the reason** — was the report justified?
3. **If it was a mistake:**
   - Restore the content by reversing the action (set `published_at` back if you unpublished, or restore the row if deleted)
   - If you reset a handle or display name, restore it from the notes you captured
     before the reset — the original is stored NOWHERE in the database, so if you
     skipped that capture step it is gone permanently
   - For a suspended account, set `content_suspended_at = null`
   - Email the user a specific apology and explanation
4. **If it was correct:**
   - Email them with a clear, kind explanation of the violation and why it was removed
   - Point to the Terms of Use
   - Do not un-suspend unless they convince you they won't repeat it

---

## What is NOT possible today

The following capabilities **do not exist** in the current schema and cannot be implemented from this runbook:

- **No admin app** — moderation happens only in the SQL editor; there's no UI
- **No in-app moderation UI** — users cannot see why their content was removed or appeal decisions
- **No account deletion from the runbook** — account deletion requires Supabase dashboard access and is a destructive operation that also deletes all the user's course logs
- **A suspended user can rename themselves back** — the permission to edit your own profile is not conditioned on suspension, so a reset handle can be changed again. Escalation is a ban at the auth layer (Dashboard -> Authentication -> user -> Ban). A future migration should gate the profiles update policy on `content_suspended_at is null`.
- **No "shadow ban"** — a suspended account's trips stay public until explicitly unpublished; content doesn't vanish on its own

---

## Checklist

### Every day
- [ ] Open Supabase → SQL Editor
- [ ] Run the "see open reports" query above
- [ ] Review each report against the decision guidance
- [ ] For each report, either dismiss it (mark resolved) or delete the content and suspend the account if needed
- [ ] Close the report with an appropriate resolution

### Weekly
- [ ] Check for patterns — one account filing repeatedly, or repeatedly targeting one person:

      ```sql
      select reporter_id, target_type, target_id, count(*), max(created_at)
      from public.content_reports
      group by 1, 2, 3
      having count(*) > 1
      order by 4 desc;
      ```
- [ ] Check email for user complaints about removed content or suspensions
- [ ] Review the list of suspended accounts to see if any should be un-suspended

---

## Contacts

- **Support email:** shuozeng21@gmail.com — users send complaints here
- **Moderation email:** File notes on actions taken; this is your audit trail for Apple if needed
