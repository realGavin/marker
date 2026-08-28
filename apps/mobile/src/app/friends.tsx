import React from "react";
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { Stack, useRouter } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import { colors, spacing, type } from "../ui/theme";
import {
  friendErrorMessage,
  useAcceptFriend,
  useDeclineFriend,
  useFindFriendByHandle,
  useFriendRequests,
  useFriends,
  useRequestFriend,
  type Friend,
  type FriendRequest,
} from "../lib/data";

export default function FriendsScreen() {
  const router = useRouter();
  const { data: friends } = useFriends();
  const { data: requests } = useFriendRequests();
  const acceptFriend = useAcceptFriend();
  const declineFriend = useDeclineFriend();
  const findByHandle = useFindFriendByHandle();
  const requestFriend = useRequestFriend();

  const busy = acceptFriend.isPending || declineFriend.isPending;

  const accept = (r: FriendRequest) => {
    acceptFriend.mutate(r.requester_id, {
      onError: (e) => Alert.alert("Couldn't accept", friendErrorMessage((e as Error).message)),
    });
  };

  const decline = (r: FriendRequest) => {
    const label = r.handle ? `@${r.handle}` : "this request";
    Alert.alert(`Decline ${label}?`, undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Decline",
        style: "destructive",
        onPress: () =>
          declineFriend.mutate(r.requester_id, {
            onError: (e) => Alert.alert("Couldn't decline", friendErrorMessage((e as Error).message)),
          }),
      },
    ]);
  };

  const sendRequest = (match: { id: string; handle: string; display_name: string | null }) => {
    requestFriend.mutate(match.handle, {
      onSuccess: (result) => {
        if (result === "accepted") {
          // They'd already asked us — asking back IS accepting. Say so plainly
          // rather than leaving it looking like just another sent request.
          Alert.alert("You're friends", `@${match.handle} had already asked to be friends — you're all set.`);
        } else if (result === "not_found") {
          // request_friend now RETURNS 'not_found' (rather than raising it)
          // for an unknown handle, so a rate-limit probe can't roll back its
          // own ledger row for free — see useRequestFriend's doc comment.
          // Same copy as the thrown-error path below, and as findByHandle's
          // own miss, since all three mean the same thing to this user.
          Alert.alert("Couldn't send request", friendErrorMessage("not_found", "handle"));
        } else {
          // No "sent requests" list exists anywhere in this app, on purpose —
          // this confirmation is the only signal the sender ever gets.
          Alert.alert("Request sent", `We'll add @${match.handle} here if they accept.`);
        }
      },
      // "handle" context: a not_found here can only mean the handle route
      // this screen sent it down (an unmatched or blocking-you handle), so
      // it must render as "No account with that handle." here too — kept for
      // an old, not-yet-redeployed function that still raises 'not_found'
      // instead of returning it.
      onError: (e) => Alert.alert("Couldn't send request", friendErrorMessage((e as Error).message, "handle")),
    });
  };

  const addByHandle = () => {
    Alert.prompt(
      "Add a friend",
      "Enter their exact @handle — there's no search by name.",
      async (input) => {
        const handle = (input ?? "").trim().replace(/^@/, "");
        if (!handle) return;
        try {
          const match = await findByHandle.mutateAsync(handle);
          if (!match) {
            Alert.alert("No match", "No account with that handle.");
            return;
          }
          const label = match.display_name ? `${match.display_name} (@${match.handle})` : `@${match.handle}`;
          Alert.alert(`Add ${label}?`, undefined, [
            { text: "Cancel", style: "cancel" },
            { text: "Send request", onPress: () => sendRequest(match) },
          ]);
        } catch (e) {
          Alert.alert("Couldn't search", friendErrorMessage((e as Error).message, "handle"));
        }
      },
      "plain-text",
    );
  };

  const hasRequests = (requests ?? []).length > 0;

  return (
    <>
      <Stack.Screen options={{ title: "Friends", headerBackTitle: "Back" }} />
      <FlatList
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={{ padding: spacing.md, flexGrow: 1 }}
        data={friends ?? []}
        keyExtractor={(item) => item.friend_id}
        ListHeaderComponent={
          hasRequests ? (
            <View style={{ marginBottom: spacing.lg }}>
              <Text style={[type.heading, { marginBottom: spacing.xs }]}>Requests</Text>
              {(requests ?? []).map((r) => (
                <View key={r.requester_id} style={styles.requestRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={type.body} numberOfLines={1}>
                      {r.display_name ?? (r.handle ? `@${r.handle}` : "Someone")}
                    </Text>
                    {r.handle && r.display_name ? (
                      <Text style={type.caption} numberOfLines={1}>
                        @{r.handle}
                      </Text>
                    ) : null}
                  </View>
                  <Pressable style={styles.declineButton} disabled={busy} onPress={() => decline(r)}>
                    <Text style={styles.declineText}>Decline</Text>
                  </Pressable>
                  <Pressable style={styles.acceptButton} disabled={busy} onPress={() => accept(r)}>
                    <Text style={styles.acceptText}>Accept</Text>
                  </Pressable>
                </View>
              ))}
              <Text style={[type.heading, { marginTop: spacing.lg }]}>Friends</Text>
            </View>
          ) : (
            <Text style={[type.heading, { marginBottom: spacing.xs }]}>Friends</Text>
          )
        }
        renderItem={({ item }: { item: Friend }) => (
          <Pressable style={styles.row} onPress={() => router.push(`/friend/${item.friend_id}`)}>
            <View style={{ flex: 1 }}>
              <Text style={type.body} numberOfLines={1}>
                {item.display_name ?? (item.handle ? `@${item.handle}` : "Friend")}
              </Text>
              <Text style={type.caption} numberOfLines={1}>
                {[item.handle ? `@${item.handle}` : null, item.home_region].filter(Boolean).join(" · ")}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
          </Pressable>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[type.body, { textAlign: "center" }]}>No friends yet</Text>
            <Text style={[type.caption, { textAlign: "center", marginTop: spacing.xs }]}>
              Add people by their exact @handle below — there's no search by name.
            </Text>
          </View>
        }
        ListFooterComponent={
          <Pressable
            style={[styles.addButton, findByHandle.isPending && { opacity: 0.7 }]}
            disabled={findByHandle.isPending}
            onPress={addByHandle}
          >
            <Ionicons name="person-add-outline" size={16} color={colors.primary} />
            <Text style={styles.addButtonText}>Add by @handle</Text>
          </Pressable>
        }
      />
    </>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.surface,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.hairline,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  requestRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    backgroundColor: colors.surface,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.hairline,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  acceptButton: {
    backgroundColor: colors.primary,
    borderRadius: 3,
    paddingHorizontal: spacing.sm,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  acceptText: { fontSize: 13, fontWeight: "700", color: "#FFFFFF" },
  declineButton: {
    borderWidth: 1.5,
    borderColor: colors.hairline,
    borderRadius: 3,
    paddingHorizontal: spacing.sm,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  declineText: { fontSize: 13, fontWeight: "700", color: colors.textSecondary },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", marginTop: spacing.xl, paddingHorizontal: spacing.lg },
  addButton: {
    flexDirection: "row",
    gap: spacing.xs,
    marginTop: spacing.sm,
    height: 46,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
  },
  addButtonText: { color: colors.primary, fontSize: 15, fontWeight: "700" },
});
