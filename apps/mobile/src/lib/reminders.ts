import * as Notifications from "expo-notifications";
import { skin } from "../skin";

/**
 * Local reminders for scheduled visits: fired on-device at T-24h and T-4h.
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

const OFFSETS: Array<{ tag: string; ms: number; lead: string }> = [
  { tag: "24h", ms: 24 * 3600_000, lead: "Tomorrow" },
  { tag: "4h", ms: 4 * 3600_000, lead: "In 4 hours" },
];

/** Returns false if the user declined notification permission. */
export async function scheduleVisitReminders(
  visitId: string,
  placeName: string,
  at: Date,
): Promise<boolean> {
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== "granted") return false;
  const timeText = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  for (const o of OFFSETS) {
    const fireAt = at.getTime() - o.ms;
    if (fireAt <= Date.now()) continue;
    await Notifications.scheduleNotificationAsync({
      identifier: `visit-${visitId}-${o.tag}`,
      content: {
        title: `${o.lead}: ${skin.vocab.visitTime.toLowerCase()} at ${placeName}`,
        body: `${timeText} — enjoy it out there.`,
        sound: true,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: new Date(fireAt),
      },
    });
  }
  return true;
}

export async function cancelVisitReminders(visitId: string): Promise<void> {
  for (const o of OFFSETS) {
    await Notifications.cancelScheduledNotificationAsync(`visit-${visitId}-${o.tag}`).catch(() => {});
  }
}

const VISIT_REMINDER_ID = /^visit-(.+)-(24h|4h)$/;

/**
 * Reconciles on-device reminders against the current visit list: cancels
 * reminders for visits that no longer exist, and re-schedules any missing
 * for visits that do (e.g. after a fresh install restored the cache but not
 * the OS notification queue). Never re-prompts for permission.
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
    if (validIds.has(m[1])) {
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
    const missing = OFFSETS.some((o) => !present.has(`visit-${v.id}-${o.tag}`));
    if (missing) await scheduleVisitReminders(v.id, v.place.name, at);
  }
}
