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
