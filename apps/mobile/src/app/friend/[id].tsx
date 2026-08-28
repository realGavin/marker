import React, { useMemo } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import { colors, spacing, type } from "../../ui/theme";
import { skin } from "../../skin";
import {
  reportErrorMessage,
  useBlockUser,
  useFriendPlaces,
  useFriendProfile,
  useRemoveFriend,
  useReportContent,
  type MyLog,
} from "../../lib/data";
import { useAuth } from "../../providers/auth";
import { ShareCard } from "../../ui/ShareCard";

/**
 * A friend's card — reuses ShareCard's dot-field presentation rather than a
 * second renderer. friend_places() carries no status/rating/note (the backend
 * never returns them for a friend, by design), so every row is adapted into
 * a MyLog-shaped "visited" entry with rating/note null. `topRated` already
 * self-hides when there's no rating data. The want-to stat is different: it
 * would compute to a hard 0 for any friend regardless of their real wishlist
 * size, which reads as a claim about them rather than an absence — so it's
 * explicitly turned off via `showWantTo={false}` instead of being left to
 * fail "soft" into a misleading number.
 */
export default function FriendProfileScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const { data: profile, isPending } = useFriendProfile(id);
  const { data: places } = useFriendPlaces(id);
  const removeFriend = useRemoveFriend();
  const blockUser = useBlockUser();
  const reportContent = useReportContent();

  const logs = useMemo<MyLog[]>(
    () =>
      (places ?? []).map((p) => ({
        place_id: p.place_id,
        status: "visited" as const,
        rating: null,
        note: null,
        place: { slug: p.slug, name: p.name, city: p.city, region: p.region },
      })),
    [places],
  );

  // Same gate as the caller's own profile badge — no medal until there's a
  // collection behind it.
  const badge = profile && profile.visited_count >= 3 ? `TOP ${profile.top_percent}%` : null;

  const remove = () => {
    if (!profile) return;
    const label = profile.handle ? `@${profile.handle}` : "this friend";
    Alert.alert(`Remove ${label}?`, "You'll stop seeing their map and they'll stop seeing yours.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => removeFriend.mutate(profile.id, { onSuccess: () => router.back() }),
      },
    ]);
  };

  const block = () => {
    if (!profile) return;
    const label = profile.handle ? `@${profile.handle}` : "this account";
    Alert.alert(`Block ${label}?`, "This also ends your friendship, and you won't see each other's activity anymore.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Block",
        style: "destructive",
        onPress: () => blockUser.mutate(profile.id, { onSuccess: () => router.back() }),
      },
    ]);
  };

  // Never offered on the caller's own profile — the RPC would refuse it with
  // `own_profile` anyway, but the control shouldn't exist to try.
  const isSelf = !!profile && !!session && profile.id === session.user.id;

  const report = () => {
    if (!profile) return;
    Alert.prompt(
      "Report this profile?",
      "This won't notify them, and it doesn't change your friendship or block status. Briefly tell us what's wrong — an offensive handle or display name, for example.",
      async (reason) => {
        try {
          await reportContent.mutateAsync({
            targetType: "profile",
            targetId: profile.id,
            reason: reason?.trim() || "unspecified",
          });
          Alert.alert(
            "Reported",
            "Thanks — we'll review this within a day. If you'd rather not see them at all in the meantime, block them too.",
          );
        } catch (e) {
          Alert.alert("Couldn't report", reportErrorMessage((e as Error).message));
        }
      },
      "plain-text",
    );
  };

  if (isPending) {
    return (
      <>
        <Stack.Screen options={{ title: "", headerBackTitle: "Back" }} />
        <View style={styles.centered}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </>
    );
  }

  if (!profile) {
    return (
      <>
        <Stack.Screen options={{ title: "", headerBackTitle: "Back" }} />
        <View style={styles.centered}>
          <Text style={type.body}>This friend isn't available anymore.</Text>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: "", headerBackTitle: "Back" }} />
      <ScrollView
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xl * 2 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          <Text style={[type.heading, { flexShrink: 1 }]} numberOfLines={1}>
            {profile.display_name ?? (profile.handle ? `@${profile.handle}` : "Friend")}
          </Text>
          {badge ? (
            <View style={styles.rankBadge}>
              <Ionicons name="medal" size={12} color="#1A1A18" />
              <Text style={styles.rankBadgeText}>{badge}</Text>
            </View>
          ) : null}
        </View>
        <Text style={[type.caption, { marginBottom: spacing.md }]}>
          {[profile.handle ? `@${profile.handle}` : null, profile.home_region].filter(Boolean).join(" · ") || " "}
        </Text>

        <ShareCard logs={logs} handle={profile.handle} badge={badge} showWantTo={false} />

        {logs.length === 0 ? (
          <Text style={[type.caption, { textAlign: "center", marginTop: spacing.sm }]}>
            No {skin.vocab.places} visited yet.
          </Text>
        ) : null}

        <Pressable style={styles.removeButton} disabled={removeFriend.isPending} onPress={remove}>
          <Ionicons name="person-remove-outline" size={16} color="#B4552D" />
          <Text style={styles.removeText}>Remove friend</Text>
        </Pressable>

        <Pressable style={styles.blockButton} disabled={blockUser.isPending} onPress={block}>
          <Ionicons name="ban-outline" size={15} color={colors.textSecondary} />
          <Text style={styles.blockText}>Block</Text>
        </Pressable>

        {!isSelf ? (
          <Pressable style={styles.reportButton} disabled={reportContent.isPending} onPress={report}>
            <Ionicons name="flag-outline" size={14} color={colors.textSecondary} />
            <Text style={styles.reportText}>Report profile</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background },
  rankBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    backgroundColor: colors.accentFill,
    borderRadius: 3,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  rankBadgeText: { fontSize: 11, fontWeight: "800", color: "#1A1A18", letterSpacing: 0.4 },
  removeButton: {
    flexDirection: "row",
    gap: spacing.xs,
    marginTop: spacing.lg,
    height: 46,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: "#B4552D",
    backgroundColor: colors.surface,
  },
  removeText: { color: "#B4552D", fontSize: 15, fontWeight: "700" },
  blockButton: {
    flexDirection: "row",
    gap: spacing.xs,
    marginTop: spacing.sm,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.sm,
  },
  blockText: { color: colors.textSecondary, fontSize: 13, fontWeight: "600" },
  reportButton: {
    flexDirection: "row",
    gap: spacing.xs,
    marginTop: spacing.xs,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: spacing.sm,
  },
  reportText: { color: colors.textSecondary, fontSize: 12, fontWeight: "600" },
});
