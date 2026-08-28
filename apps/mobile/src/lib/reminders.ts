import * as Notifications from "expo-notifications";

/**
 * Local reminders for scheduled visits.
 *
 * Two reminders map to what someone actually does before a visit:
 *  - "evening": fixed at 19:00 local the day before — pack up, check the
 *    weather, plan the drive.
 *  - "leave": the user's own travel time plus a fixed check-in/warm-up
 *    buffer before the visit. Falls back to a flat 2 hours when no travel
 *    time has been set on the visit, so reminders don't regress for anyone
 *    who hasn't set one.
 *
 * Neither may ever fire between 21:00 and 06:30 local (nobody wants an alarm
 * at 3am for an early-morning slot), and a "leave" reminder that would land
 * within 15 minutes of — or after — the visit is worse than no reminder at
 * all, so it's dropped rather than clamped forward past the visit.
 *
 * No server, no push infrastructure — flat-cost by construction. Notification
 * identifiers derive from the visit-time row id so deletes can cancel them.
 */

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/** Current reminder tags this app schedules. */
const CURRENT_TAGS = ["evening", "leave"] as const;

/**
 * LEGACY tags from the old T-24h / T-4h scheme (replaced because a 4-hours-
 * before reminder for an early-morning visit could fire as early as 3am).
 * Nothing schedules these any more, but TestFlight testers already have
 * notifications queued on-device under these identifiers, and those alarms
 * will keep firing until they're explicitly cancelled. `cancelVisitReminders`
 * and the orphan-cleanup pass in `reconcileReminders` must keep recognizing
 * these tags so old installs get them cancelled on their next reconcile —
 * do NOT remove this list until every install has reconciled at least once.
 */
const LEGACY_TAGS = ["24h", "4h"] as const;

const ALL_KNOWN_TAGS = [...CURRENT_TAGS, ...LEGACY_TAGS];

const NIGHT_END_HOUR = 6;
const NIGHT_END_MINUTE = 30;
const NIGHT_START_HOUR = 21;
/** Fallback lead time when a visit has no travel time set — unchanged from before travel-aware reminders existed. */
const DEFAULT_LEAVE_LEAD_MS = 2 * 3600_000;
/** Check-in / warm-up buffer added on top of travel time for the "leave" reminder. */
const CHECKIN_BUFFER_MIN = 30;
const MIN_LEAD_BEFORE_VISIT_MS = 15 * 60_000;
/**
 * Tolerance used when comparing a freshly-recomputed fire time against the
 * fire time stashed in an already-scheduled notification's own payload (see
 * `data.fireAt` in `scheduleVisitReminders`). The two should match exactly
 * since we round-trip a raw millisecond timestamp through our own payload
 * rather than through any OS-native trigger representation, but a small
 * tolerance is kept as cheap insurance against float/serialization edge
 * cases so it never forces a needless reschedule on every reconcile.
 */
const SAME_FIRE_TIME_TOLERANCE_MS = 60_000;

/** Builds a Date from local date components — safe across a DST boundary. */
function localDate(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(year, month, day, hour, minute, 0, 0);
}

/**
 * 19:00 local the day before `at`, built from local date components (not by
 * subtracting a fixed number of milliseconds — that drifts by an hour across
 * a DST change).
 */
function eveningBeforeTime(at: Date): Date {
  return localDate(at.getFullYear(), at.getMonth(), at.getDate() - 1, 19, 0);
}

/**
 * Pulls a candidate time forward out of the 21:00–06:30 local blackout
 * window and onto the nearest following daytime instant. A pre-dawn
 * candidate (e.g. 4am for a 6am visit) moves to 06:30 the same calendar day;
 * a late-night candidate (rare — a visit after ~23:00) moves to 06:30 the
 * *next* calendar day, which the 15-minutes-or-after check below will then
 * correctly drop since it lands after the visit.
 */
function pullOutOfNightWindow(candidate: Date): Date {
  const hour = candidate.getHours() + candidate.getMinutes() / 60;
  const y = candidate.getFullYear();
  const m = candidate.getMonth();
  const d = candidate.getDate();
  if (hour < NIGHT_END_HOUR + NIGHT_END_MINUTE / 60) {
    return localDate(y, m, d, NIGHT_END_HOUR, NIGHT_END_MINUTE);
  }
  if (hour >= NIGHT_START_HOUR) {
    return localDate(y, m, d + 1, NIGHT_END_HOUR, NIGHT_END_MINUTE);
  }
  return candidate;
}

export interface LeaveReminder {
  fireAt: Date;
  /**
   * True when the 21:00–06:30 night-window clamp ate far enough into the
   * travel lead that this fire time no longer leaves time to arrive before
   * `at` — still worth firing (a late nudge beats silence) but dishonest to
   * word as "time to leave".
   */
  late: boolean;
}

/**
 * "Time to leave" fire time, or null when this reminder should be skipped
 * entirely: either the clamped time lands within 15 minutes of (or after)
 * the visit itself, e.g. a 6:30 alert for a 6:00 start.
 *
 * Lead time is the user's own travel time plus the check-in buffer; when no
 * travel time has been set (`travelMinutes` is null) this falls back to the
 * flat default so existing reminders don't change.
 */
function leaveTime(at: Date, travelMinutes: number | null): LeaveReminder | null {
  const leadMs =
    travelMinutes != null ? (travelMinutes + CHECKIN_BUFFER_MIN) * 60_000 : DEFAULT_LEAVE_LEAD_MS;
  const raw = new Date(at.getTime() - leadMs);
  const clamped = pullOutOfNightWindow(raw);
  const actualLeadMs = at.getTime() - clamped.getTime();
  if (actualLeadMs <= MIN_LEAD_BEFORE_VISIT_MS) return null;
  const late = travelMinutes != null && actualLeadMs < travelMinutes * 60_000;
  return { fireAt: clamped, late };
}

/**
 * Read-only preview of the "leave" reminder for a visit, for UI display —
 * e.g. a caption showing the computed fire time, or that none will fire at
 * all. Applies the exact same rules `planReminders` uses to actually
 * schedule it.
 */
export function previewLeaveReminder(at: Date, travelMinutes: number | null): LeaveReminder | null {
  return leaveTime(at, travelMinutes);
}

interface ReminderPlan {
  tag: (typeof CURRENT_TAGS)[number];
  fireAt: Date;
  title: string;
  body: string;
}

/**
 * Computes which of the two reminders should actually be scheduled for a
 * visit, given the current time. Pure (aside from reading Date.now()) so the
 * scheduling rules can be reasoned about — and unit-tested — independent of
 * the notifications API.
 */
function planReminders(
  placeName: string,
  at: Date,
  now: number,
  travelMinutes: number | null,
): ReminderPlan[] {
  const timeText = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const plans: ReminderPlan[] = [];

  const evening = eveningBeforeTime(at);
  if (evening.getTime() > now) {
    plans.push({
      tag: "evening",
      fireAt: evening,
      title: `Tomorrow at ${placeName}`,
      // Names the place and the time; no wording that implies a booking or
      // a confirmation from the venue — this is only a self-set reminder.
      body: `${timeText} — pack up and check the weather.`,
    });
  }

  const leave = leaveTime(at, travelMinutes);
  if (leave && leave.fireAt.getTime() > now) {
    plans.push({
      tag: "leave",
      fireAt: leave.fireAt,
      title: `${placeName} at ${timeText}`,
      body:
        // A clamped-and-late reminder must not claim there's still time to
        // leave — it fires after the window where that would be true.
        leave.late && travelMinutes != null
          ? `Running late — ${placeName} is about ${travelMinutes} minutes away.`
          : travelMinutes != null && travelMinutes > 0
            ? `Time to head out — about ${travelMinutes} minutes away.`
            : "Time to head out.",
    });
  }

  return plans;
}

/**
 * Returns false if the user declined notification permission.
 *
 * Scheduling only ever adds or replaces a tag `planReminders` still wants;
 * a tag it no longer wants (e.g. "leave" dropped because the night-window
 * clamp ate the whole lead, or a travel-time edit pushes the fire time past
 * the visit) needs an explicit cancel here too, since nothing else calls
 * this function ever removes anything on its own — see reconcileReminders'
 * own per-tag cancel, which this mirrors for callers (like TravelMinutes)
 * that invoke this directly instead of going through reconcile.
 */
export async function scheduleVisitReminders(
  visitId: string,
  placeName: string,
  at: Date,
  travelMinutes: number | null = null,
): Promise<boolean> {
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== "granted") return false;
  const plans = planReminders(placeName, at, Date.now(), travelMinutes);
  const plannedTags = new Set(plans.map((p) => p.tag));
  for (const tag of CURRENT_TAGS) {
    if (plannedTags.has(tag)) continue;
    await Notifications.cancelScheduledNotificationAsync(`visit-${visitId}-${tag}`).catch(() => {});
  }
  for (const plan of plans) {
    await Notifications.scheduleNotificationAsync({
      identifier: `visit-${visitId}-${plan.tag}`,
      content: {
        title: plan.title,
        body: plan.body,
        sound: true,
        // Stashed so a later reconcile can tell whether the fire time it
        // would compute today still matches what's actually scheduled,
        // without depending on how the OS represents the trigger — see
        // `existingFireAt` and SAME_FIRE_TIME_TOLERANCE_MS.
        data: { fireAt: plan.fireAt.getTime() },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: plan.fireAt,
      },
    });
  }
  return true;
}

export async function cancelVisitReminders(visitId: string): Promise<void> {
  // Cancels both current tags and the legacy 24h/4h tags — see LEGACY_TAGS.
  for (const tag of ALL_KNOWN_TAGS) {
    await Notifications.cancelScheduledNotificationAsync(`visit-${visitId}-${tag}`).catch(() => {});
  }
}

const VISIT_REMINDER_ID = /^visit-(.+)-(evening|leave|24h|4h)$/;
const LEGACY_TAG_SET: ReadonlySet<string> = new Set(LEGACY_TAGS);

/**
 * Extracts the fire time a scheduled notification was *intended* to fire at,
 * from the `data.fireAt` payload `scheduleVisitReminders` stashes on every
 * notification it creates (a raw milliseconds-since-epoch number).
 *
 * This deliberately does NOT read the OS-native `trigger` shape. expo-
 * notifications converts a DATE trigger into a platform-specific
 * representation — on iOS 57 a DATE trigger comes back from
 * `getAllScheduledNotificationsAsync()` as a `UNTimeIntervalNotification-
 * Trigger` (`{ type: "timeInterval", seconds: <n>, repeats: false }`), where
 * `seconds` is the *configured* interval rather than time-remaining, so the
 * absolute fire time is not recoverable from the trigger payload at all. A
 * notification scheduled before this payload existed (i.e. before this app
 * version) has no `data.fireAt` and returns null here, which the caller
 * treats as "can't confirm it matches" and reschedules — safe, since
 * identifiers are stable and `scheduleNotificationAsync` replaces in place,
 * so the worst case is one redundant write, never a missed one.
 */
function existingFireAt(existing: Notifications.NotificationRequest): Date | null {
  const raw = existing.content?.data?.fireAt;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return new Date(raw);
}

/** Within a minute counts as "the same" fire time — see SAME_FIRE_TIME_TOLERANCE_MS. */
function sameFireTime(a: Date, b: Date): boolean {
  return Math.abs(a.getTime() - b.getTime()) < SAME_FIRE_TIME_TOLERANCE_MS;
}

/**
 * Cancels anything still scheduled under a legacy 24h/4h identifier (see
 * LEGACY_TAGS), independent of any visit data — it only reads the on-device
 * notification queue. This is the ONLY thing that ever cancels those old
 * alarms (including the 3am one), so it must run unconditionally on every
 * app start rather than as a side effect of a successful visit-times fetch:
 * gating it on server data means an unreachable view (migration not yet
 * applied, offline first launch, expired session) leaves testers' devices
 * with the legacy alarms queued forever.
 */
export async function cancelLegacyReminders(): Promise<void> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  for (const n of scheduled) {
    const m = VISIT_REMINDER_ID.exec(n.identifier);
    if (!m) continue;
    const tag = m[2];
    if (LEGACY_TAG_SET.has(tag!)) {
      await Notifications.cancelScheduledNotificationAsync(n.identifier).catch(() => {});
    }
  }
}

/**
 * Reconciles on-device reminders against the current visit list: cancels
 * reminders for visits that no longer exist, and re-schedules any that are
 * missing OR whose actually-scheduled fire time no longer matches what
 * `planReminders` computes today (e.g. travel time changed, or the visit's
 * time moved) — comparing by trigger date rather than by identifier
 * presence, since both tags are scheduled up front and stay "present"
 * forever even after their fire time has gone stale. Never re-prompts for
 * permission.
 *
 * Also unconditionally cancels anything still scheduled under a legacy tag,
 * regardless of whether the visit still exists — those old 24h/4h alerts
 * (including the 3am one) were replaced by the evening/leave scheme and must
 * not be left to fire just because their visit is still upcoming.
 */
export async function reconcileReminders(
  visits: Array<{ id: string; at: string; place_name: string; travel_minutes: number | null }>,
): Promise<void> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  const validIds = new Set(visits.map((v) => v.id));
  const byIdentifier = new Map<string, Notifications.NotificationRequest>();
  for (const n of scheduled) {
    const m = VISIT_REMINDER_ID.exec(n.identifier);
    if (!m) continue;
    const [, visitId, tag] = m;
    if (LEGACY_TAG_SET.has(tag!)) {
      await Notifications.cancelScheduledNotificationAsync(n.identifier).catch(() => {});
      continue;
    }
    if (validIds.has(visitId!)) {
      byIdentifier.set(n.identifier, n);
    } else {
      await Notifications.cancelScheduledNotificationAsync(n.identifier).catch(() => {});
    }
  }

  const { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") return;

  for (const v of visits) {
    const at = new Date(v.at);
    if (at.getTime() <= Date.now()) continue;
    const plans = planReminders(v.place_name, at, Date.now(), v.travel_minutes);
    const plannedTags = new Set(plans.map((p) => p.tag));

    // A tag that used to be scheduled but today's plan no longer wants (e.g.
    // the "leave" reminder now gets dropped because the night-window clamp
    // ate the whole lead) needs an explicit cancel — scheduling only ever
    // adds or replaces, it never removes.
    for (const tag of CURRENT_TAGS) {
      if (plannedTags.has(tag)) continue;
      const identifier = `visit-${v.id}-${tag}`;
      if (byIdentifier.has(identifier)) {
        await Notifications.cancelScheduledNotificationAsync(identifier).catch(() => {});
      }
    }

    const needsReschedule = plans.some((plan) => {
      const existing = byIdentifier.get(`visit-${v.id}-${plan.tag}`);
      if (!existing) return true;
      const fireAt = existingFireAt(existing);
      return !fireAt || !sameFireTime(fireAt, plan.fireAt);
    });
    if (needsReschedule) await scheduleVisitReminders(v.id, v.place_name, at, v.travel_minutes);
  }
}
