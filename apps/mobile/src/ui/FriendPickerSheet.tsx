import React from "react";
import { FlatList, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { colors, radii, spacing, type } from "./theme";
import { useFriends, type Friend } from "../lib/data";

/**
 * Bottom-sheet friend picker, shared by the owner-only "invite a friend" flows
 * on a trip and a visit time. The existing invite-code share stays untouched
 * next to this everywhere it's used — this is an additional door, not a
 * replacement (see invite_friend_to_trip/visit in the friends migration).
 *
 * `doneIds` marks friends already invited in this sheet session so a picker
 * left open reads as a running list rather than resetting after each tap;
 * inviting is idempotent server-side either way.
 */
export function FriendPickerSheet({
  visible,
  onClose,
  onPick,
  busyId,
  doneIds,
  title = "Invite a friend",
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (friend: Friend) => void;
  busyId?: string | null;
  doneIds?: Set<string>;
  title?: string;
}) {
  const { data: friends } = useFriends();

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.flexFill}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={styles.sheet}>
          <View style={styles.header}>
            <Text style={type.heading}>{title}</Text>
            <Pressable hitSlop={8} onPress={onClose}>
              <Ionicons name="close" size={20} color={colors.textSecondary} />
            </Pressable>
          </View>
          <FlatList
            data={friends ?? []}
            keyExtractor={(f) => f.friend_id}
            style={{ maxHeight: 360 }}
            ListEmptyComponent={
              <Text style={[type.caption, { paddingVertical: spacing.md }]}>
                You don't have any friends yet — add someone from Friends first.
              </Text>
            }
            renderItem={({ item }) => {
              const busy = busyId === item.friend_id;
              const done = doneIds?.has(item.friend_id) ?? false;
              return (
                <Pressable
                  style={[styles.row, (busy || done) && { opacity: 0.6 }]}
                  disabled={busy || done || !!busyId}
                  onPress={() => onPick(item)}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={type.body} numberOfLines={1}>
                      {item.display_name ?? (item.handle ? `@${item.handle}` : "Friend")}
                    </Text>
                    {item.handle && item.display_name && (
                      <Text style={type.caption} numberOfLines={1}>
                        @{item.handle}
                      </Text>
                    )}
                  </View>
                  {busy ? (
                    <Text style={type.caption}>Inviting…</Text>
                  ) : done ? (
                    <Ionicons name="checkmark-circle" size={20} color={colors.primary} />
                  ) : (
                    <Ionicons name="add-circle-outline" size={20} color={colors.primary} />
                  )}
                </Pressable>
              );
            }}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flexFill: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
    padding: spacing.md,
    paddingBottom: spacing.xl,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.hairline,
  },
});
