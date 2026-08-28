import React, { useState } from "react";
import { Alert, Pressable, Share, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { skin } from "../skin";
import { colors, spacing, type } from "./theme";
import {
  friendErrorMessage,
  useDeleteVisitTime,
  useInviteFriendToVisit,
  useLeaveVisitTime,
  visitErrorMessage,
  type Friend,
  type VisitTime,
} from "../lib/data";
import { cancelVisitReminders } from "../lib/reminders";
import { FriendPickerSheet } from "./FriendPickerSheet";
import { TravelMinutesRow } from "./TravelMinutes";

/**
 * One row in an upcoming-visit list: date, this device's travel time, the
 * member count when shared, and the owner- or member-appropriate action.
 * Owners delete (unchanged — direct DELETE is still allowed); everyone else
 * leaves via `leave_visit`, which then cancels this device's own reminders
 * for it (each device schedules its own — there's no push server to fan
 * that out). Shared by the trips rail and a place's own visit list —
 * `onPressPlace` is omitted on the place page since the place is already
 * the page you're on.
 */
export function VisitTimeRow({
  visit,
  onPressPlace,
}: {
  visit: VisitTime;
  onPressPlace?: () => void;
}) {
  const deleteVisitTime = useDeleteVisitTime();
  const leaveVisitTime = useLeaveVisitTime();
  const inviteFriendToVisit = useInviteFriendToVisit();
  const [friendPickerOpen, setFriendPickerOpen] = useState(false);
  const [invitingFriendId, setInvitingFriendId] = useState<string | null>(null);
  const [invitedFriendIds, setInvitedFriendIds] = useState<Set<string>>(new Set());

  const inviteFriend = async (friend: Friend) => {
    setInvitingFriendId(friend.friend_id);
    try {
      await inviteFriendToVisit.mutateAsync({ visitId: visit.id, friendId: friend.friend_id });
      setInvitedFriendIds((prev) => new Set(prev).add(friend.friend_id));
    } catch (e) {
      Alert.alert("Couldn't invite", friendErrorMessage((e as Error).message));
    } finally {
      setInvitingFriendId(null);
    }
  };

  const remove = () => {
    deleteVisitTime.mutate(visit.id);
    cancelVisitReminders(visit.id).catch(() => {});
  };

  const leave = () => {
    Alert.alert("Leave this?", "You'll stop getting reminders for it on this device.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Leave",
        style: "destructive",
        onPress: () =>
          leaveVisitTime.mutate(visit.id, {
            onSuccess: () => cancelVisitReminders(visit.id).catch(() => {}),
            onError: (e) => Alert.alert("Couldn't leave", visitErrorMessage((e as Error).message)),
          }),
      },
    ]);
  };

  const share = () => {
    if (!visit.invite_code) return;
    const visitTimeLower = skin.vocab.visitTime.toLowerCase();
    Share.share({
      // "reminder" stays in both the invite and the button it points at —
      // this schedules a local alarm on each person's own phone, not a
      // booking. There's no push server, so the clause at the end matters:
      // without it, the sender could easily think tapping share notified
      // the other person's phone, which it never does.
      message: `Join my ${visitTimeLower} reminder in ${skin.vocab.appName}: open the app, go to Trips, tap "Join a ${visitTimeLower} reminder", and enter code ${visit.invite_code}. You'll get your own reminder, timed to your own travel time, once you join and open the app.`,
    }).catch(() => {});
  };

  const dateText = new Date(visit.at).toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <View
      style={{
        paddingVertical: spacing.sm,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: "#E7E7E3",
        gap: 4,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Ionicons name="alarm" size={15} color={colors.accent} />
        <Pressable style={{ flex: 1 }} onPress={onPressPlace} disabled={!onPressPlace}>
          {onPressPlace && (
            <Text style={type.body} numberOfLines={1}>
              {visit.place_name}
            </Text>
          )}
          <Text style={type.caption}>
            {dateText}
            {visit.member_count > 1 ? ` · ${visit.member_count} going` : ""}
          </Text>
        </Pressable>
        {visit.is_owner && (
          <Pressable hitSlop={8} onPress={() => setFriendPickerOpen(true)}>
            <Ionicons name="person-add-outline" size={16} color={colors.primary} />
          </Pressable>
        )}
        {visit.is_owner && visit.invite_code && (
          <Pressable hitSlop={8} onPress={share}>
            <Ionicons name="share-outline" size={17} color={colors.primary} />
          </Pressable>
        )}
        <Pressable hitSlop={8} onPress={visit.is_owner ? remove : leave}>
          <Ionicons
            name={visit.is_owner ? "close-circle-outline" : "exit-outline"}
            size={18}
            color={colors.textSecondary}
          />
        </Pressable>
      </View>
      <TravelMinutesRow visit={visit} />
      {visit.is_owner && (
        <FriendPickerSheet
          visible={friendPickerOpen}
          onClose={() => setFriendPickerOpen(false)}
          onPick={inviteFriend}
          busyId={invitingFriendId}
          doneIds={invitedFriendIds}
          title={`Invite a friend to this ${skin.vocab.visitTime.toLowerCase()}`}
        />
      )}
    </View>
  );
}
