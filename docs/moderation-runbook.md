# Moderation Runbook

Operational guide for reviewing and actioning user reports of objectionable content. Audience: solo operator with Supabase dashboard access (SQL editor, read-only role for safety).

---

## Where reports land

All user-reported content is written to `public.content_reports` via the app. Each row contains:
- `id` (uuid, primary key)
- `reported_at` (timestamp with timezone, automatically set)
- `reporter_id` (uuid, the account that filed the report)
- `trip_id` (uuid, nullable — if reporting a trip)
- `condition_report_id` (uuid, nullable — if reporting a condition report)
- `reason` (text, user's explanation)
- `status` (text: `open`, `dismissed`, `deleted`)

**Access:** Open Supabase → SQL Editor → paste queries below. Read-only role used to prevent accidental mutations.

---

## List all open reports

Run this to see what needs review:

```sql
SELECT 
  cr.id,
  cr.reported_at,
  cr.reason,
  cr.status,
  CASE 
    WHEN cr.trip_id IS NOT NULL THEN 'trip'
    WHEN cr.condition_report_id IS NOT NULL THEN 'condition_report'
    ELSE 'unknown'
  END as content_type,
  u.username as reporter_handle,
  CASE 
    WHEN cr.trip_id IS NOT NULL THEN (SELECT u2.username FROM auth.users u2 JOIN public.trips t ON t.created_by = u2.id WHERE t.id = cr.trip_id)
    WHEN cr.condition_report_id IS NOT NULL THEN (SELECT u2.username FROM auth.users u2 JOIN public.condition_reports c ON c.user_id = u2.id WHERE c.id = cr.condition_report_id)
    ELSE NULL
  END as author_handle
FROM public.content_reports cr
LEFT JOIN auth.users u ON u.id = cr.reporter_id
WHERE cr.status = 'open'
ORDER BY cr.reported_at ASC;
```

This shows:
- When it was reported
- Why (the reason text)
- Who reported it (reporter_handle)
- Who created it (author_handle)
- Type (trip or condition_report)

---

## Decision guidance

### Delete if the content:
- **Threatens or harasses** a specific person or group.
- **Impersonates** someone else.
- **Is spam** or purely promotional.
- **Describes illegal activity** or encourages harm.
- **Is clearly abusive** and has no other value.

### Dismiss if:
- **It's a disagreement**, not a violation (e.g., "I don't like this golf course rating").
- **It's marginal** and another moderator might disagree (err on the side of leaving it).
- **Context matters** and the content looks OK in full (e.g., sarcasm, local slang).
- **Reporter has a pattern** of frivolous reports (after 2–3, mark them dismissed).

### When in doubt:
- Sleep on it. Come back in 4 hours.
- If still unsure after a day, **dismiss it** (the cost of a false negative is lower than censoring speech).

---

## Delete a trip

```sql
BEGIN;
UPDATE public.content_reports SET status = 'deleted' WHERE trip_id = '<TRIP_ID>' AND status = 'open';
DELETE FROM public.trip_itinerary_items WHERE trip_id = '<TRIP_ID>';
DELETE FROM public.trip_members WHERE trip_id = '<TRIP_ID>';
DELETE FROM public.trips WHERE id = '<TRIP_ID>';
COMMIT;
```

Replace `<TRIP_ID>` with the uuid from the report row. Run in a transaction so if any step fails, nothing is deleted.

---

## Delete a condition report

```sql
BEGIN;
UPDATE public.content_reports SET status = 'deleted' WHERE condition_report_id = '<REPORT_ID>' AND status = 'open';
DELETE FROM public.condition_reports WHERE id = '<REPORT_ID>';
COMMIT;
```

Replace `<REPORT_ID>` with the uuid from the report row.

---

## Suspend an account

For accounts that have posted multiple violations or severe abuse, suspend them from publishing (do not delete the account — that erases their course logs and history, which other users may depend on).

```sql
BEGIN;
UPDATE auth.users SET is_banned = TRUE WHERE id = '<USER_ID>';
-- Also mark their open reports as deleted so they don't clutter the queue
UPDATE public.content_reports 
  SET status = 'deleted' 
  WHERE (
    trip_id IN (SELECT id FROM public.trips WHERE created_by = '<USER_ID>')
    OR condition_report_id IN (SELECT id FROM public.condition_reports WHERE user_id = '<USER_ID>')
  )
  AND status = 'open';
COMMIT;
```

This flags the account as banned (the app checks this at publish time) and clears their open reports from the queue. The account itself remains; the user can still log in and view their own content, but cannot create new trips, condition reports, or lists.

---

## The 24-hour commitment

**Why:** Apple App Review Guideline 1.2 requires prompt moderation of user-generated content. "Prompt" is interpreted as 24 hours.

**What it means:**
- Check the queue at least once per day.
- On reports filed between Tuesday 10am and Wednesday 10am, you have until Thursday 10am to act (dismiss or delete).
- If you're away, queue someone else to cover.

**What counts:**
- Filing the report (e.g., marking as `dismissed` or `deleted` in the database).
- Does not require a reply to the user (we don't have a built-in feedback system yet).

---

## If a user claims unfair blocking

Users may email saying their content was deleted or their account was suspended unfairly.

1. **Check the report** — run the open-reports query above and look for their content in the historical `content_reports` rows (include `deleted` status in your WHERE clause).
2. **Review the reason** — was it actually a violation?
3. **If it was a mistake:**
   - Restore the content by reversing the delete (this requires a backup, or carefully re-inserting if you have the data).
   - Email the user an apology and explanation (be specific, not defensive).
   - If it was their account that was suspended, update `auth.users SET is_banned = FALSE WHERE id = '<USER_ID>'`.
4. **If it was correct:**
   - Email them with a clear, kind explanation of the violation and why it was removed.
   - Point to the Terms of Use (link: `https://marker-tiles.shuozeng21.workers.dev/terms`).
   - Do not unban unless they convince you they won't repeat it.

---

## Checklists

### Daily (every morning or evening)

- [ ] Open Supabase SQL editor.
- [ ] Paste and run the "list all open reports" query above.
- [ ] If any exist, review each one against the decision guidance.
- [ ] For each report, either dismiss it or delete the content.
- [ ] Mark the report `status = 'dismissed'` or rely on the delete queries to auto-mark it (the delete queries include the UPDATE statement).

### Weekly

- [ ] Check if any users have emailed complaints about removed content or suspensions.
- [ ] Verify no patterns of abuse are growing unchecked (e.g., one user filing 10 reports against a single other user).

---

## Contacts

- **Support email:** shuozeng21@gmail.com — users send complaints here.
- **Apple App Review:** If Apple rejects the app for moderation failures (rare), the rejection notice will cite specific content or patterns. Respond with this runbook as proof of your process.
