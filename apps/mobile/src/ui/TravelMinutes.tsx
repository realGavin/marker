import React from "react";
import { Alert, Pressable, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { colors, spacing, type } from "./theme";
import { useSetTravelMinutes, visitErrorMessage, type VisitTime } from "../lib/data";
import { previewLeaveReminder, scheduleVisitReminders } from "../lib/reminders";

/** Backend's accepted range for a travel-minutes value (see set_travel_minutes). */
export const MAX_TRAVEL_MINUTES = 480;
export const MIN_TRAVEL_MINUTES = 0;

/**
 * Opens a numeric prompt to set (or clear) a travel-minutes value, validating
 * against the backend's accepted range before calling back. Shared by the
 * draft field on the visit-creation form and the saved-visit editor below —
 * one place owns the validation and the copy.
 */
export function promptForTravelMinutes(
  initial: number | null,
  onSubmit: (minutes: number | null) => void,
): void {
  Alert.prompt(
    "Travel time",
    "Minutes to get there — leave blank to clear",
    (text) => {
      const trimmed = text?.trim() ?? "";
      if (trimmed === "") {
        onSubmit(null);
        return;
      }
      const n = Math.round(Number(trimmed));
      if (!Number.isFinite(n) || n < MIN_TRAVEL_MINUTES || n > MAX_TRAVEL_MINUTES) {
        Alert.alert("Invalid", `Enter a whole number of minutes between ${MIN_TRAVEL_MINUTES} and ${MAX_TRAVEL_MINUTES}.`);
        return;
      }
      onSubmit(n);
    },
    "plain-text",
    initial != null ? String(initial) : "",
    "number-pad",
  );
}

/** e.g. "Reminder 7:15am". */
function reminderCaption(at: Date, travelMinutes: number | null): string {
  const leave = previewLeaveReminder(at, travelMinutes);
  if (!leave || leave.fireAt.getTime() <= Date.now()) return "No leave reminder will fire";
  const timeText = leave.fireAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return leave.late ? `Reminder ${timeText} (running late)` : `Reminder ${timeText}`;
}

/**
 * Tappable "N min away" row for an already-saved visit — edits go straight
 * to `set_travel_minutes` and immediately reschedule this device's own
 * reminder so the new lead time takes effect without waiting on a refetch.
 * Once a value is saved it's just the user's own number — never flagged as
 * an estimate, because nothing on this screen guesses one any more.
 */
export function TravelMinutesRow({
  visit,
}: {
  visit: Pick<VisitTime, "id" | "place_name" | "at" | "travel_minutes">;
}) {
  const setTravel = useSetTravelMinutes();
  const at = new Date(visit.at);

  const edit = () =>
    promptForTravelMinutes(visit.travel_minutes, (n) =>
      setTravel.mutate(
        { visitId: visit.id, minutes: n },
        {
          onSuccess: () => {
            scheduleVisitReminders(visit.id, visit.place_name, at, n).catch(() => {});
          },
          onError: (e) => Alert.alert("Couldn't update", visitErrorMessage((e as Error).message)),
        },
      ),
    );

  return (
    <Pressable style={{ flexDirection: "row", alignItems: "center", gap: 4 }} onPress={edit} hitSlop={6}>
      <Ionicons name="car-outline" size={13} color={colors.textSecondary} />
      <Text style={type.caption}>
        {visit.travel_minutes != null ? `${visit.travel_minutes} min away` : "Set travel time"}
        {" · "}
        {reminderCaption(at, visit.travel_minutes)}
      </Text>
    </Pressable>
  );
}

/**
 * Editable draft row shown while creating a visit, before it has an id to
 * save against. A plain typed number, nothing prefilled — this screen has no
 * routing data source, so any prefill here would be a guess dressed up as a
 * real drive time the moment the visit saves.
 */
export function DraftTravelMinutesRow({
  minutes,
  onChange,
}: {
  minutes: number | null;
  onChange: (minutes: number | null) => void;
}) {
  return (
    <Pressable
      style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.sm }}
      onPress={() => promptForTravelMinutes(minutes, onChange)}
    >
      <Ionicons name="car-outline" size={16} color={colors.primary} />
      <View style={{ flex: 1 }}>
        <Text style={type.body}>{minutes != null ? `${minutes} min away` : "Add a travel time"}</Text>
      </View>
      <Ionicons name="chevron-forward" size={14} color={colors.textSecondary} />
    </Pressable>
  );
}
