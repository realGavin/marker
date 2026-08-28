import * as Notifications from "expo-notifications";

/**
 * Local reminders for scheduled visits.
 *
 * Two reminders map to what someone actually does before a visit:
 *  - "evening": fixed at 19:00 local the day before — pack up, check the
 *    weather, plan the drive.
 *  - "leave": 2 hours before the visit — roughly travel time plus enough
 *    buffer to check in and warm up.
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
const LEAVE_LEAD_MS = 2 * 3600_000;
const MIN_LEAD_BEFORE_VISIT_MS = 15 * 60_000;

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

/**
 * "Time to leave" fire time, or null when this reminder should be skipped
 * entirely: either the clamped time lands within 15 minutes of (or after)
 * the visit itself, e.g. a 6:30 alert for a 6:00 start.
 */
function leaveTime(at: Date): Date | null {
  const raw = new Date(at.getTime() - LEAVE_LEAD_MS);
  const clamped = pullOutOfNightWindow(raw);
  if (at.getTime() - clamped.getTime() <= MIN_LEAD_BEFORE_VISIT_MS) return null;
  return clamped;
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
function planReminders(placeName: string, at: Date, now: number): ReminderPlan[] {
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

  const leave = leaveTime(at);
  if (leave && leave.getTime() > now) {
    plans.push({
      tag: "leave",
      fireAt: leave,
      title: `${placeName} at ${timeText}`,
      body: "Time to head out.",
    });
  }

  return plans;
}

/** Returns false if the user declined notification permission. */
export async function scheduleVisitReminders(
  visitId: string,
  placeName: string,
  at: Date,
): Promise<boolean> {
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== "granted") return false;
  for (const plan of planReminders(placeName, at, Date.now())) {
    await Notifications.scheduleNotificationAsync({
      identifier: `visit-${visitId}-${plan.tag}`,
      content: {
        title: plan.title,
        body: plan.body,
        sound: true,
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
 * Reconciles on-device reminders against the current visit list: cancels
 * reminders for visits that no longer exist, and re-schedules any missing
 * for visits that do (e.g. after a fresh install restored the cache but not
 * the OS notification queue). Never re-prompts for permission.
 *
 * Also unconditionally cancels anything still scheduled under a legacy tag,
 * regardless of whether the visit still exists — those old 24h/4h alerts
 * (including the 3am one) were replaced by the evening/leave scheme and must
 * not be left to fire just because their visit is still upcoming.
 */
export async function reconcileReminders(
  visits: Array<{ id: string; at: string; place: { name: string } }>,
): Promise<void> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  const validIds = new Set(visits.map((v) => v.id));
  const present = new Set<string>();
  for (const n of scheduled) {
    const m = VISIT_REMINDER_ID.exec(n.identifier);
    if (!m) continue;
    const [, visitId, tag] = m;
    if (LEGACY_TAG_SET.has(tag!)) {
      await Notifications.cancelScheduledNotificationAsync(n.identifier).catch(() => {});
      continue;
    }
    if (validIds.has(visitId!)) {
      present.add(n.identifier);
    } else {
      await Notifications.cancelScheduledNotificationAsync(n.identifier).catch(() => {});
    }
  }

  const { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") return;

  for (const v of visits) {
    const at = new Date(v.at);
    if (at.getTime() <= Date.now()) continue;
    const missing = CURRENT_TAGS.some((tag) => !present.has(`visit-${v.id}-${tag}`));
    if (missing) await scheduleVisitReminders(v.id, v.place.name, at);
  }
}
