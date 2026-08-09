import React, { useRef, useState } from "react";
import { Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { getSupabase } from "../../lib/supabase";
import { captureRef } from "react-native-view-shot";
import * as Sharing from "expo-sharing";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import { useAuth } from "../../providers/auth";
import { usePurchases } from "../../providers/purchases";
import { useMyBlocks, useMyLogs, useMyRank, useProfile } from "../../lib/data";
import { ShareCard } from "../../ui/ShareCard";
import { skin } from "../../skin";
import { colors, spacing, type } from "../../ui/theme";

export default function ProfileScreen() {
  const router = useRouter();
  const { session, signOut } = useAuth();
  const { isPro } = usePurchases();
  const { data: logs } = useMyLogs();
  const { data: profile } = useProfile();
  const cardRef = useRef<View>(null);
  const [sharing, setSharing] = useState(false);

  const handle = profile?.handle ?? session?.user.email?.split("@")[0] ?? null;
  const { data: rank } = useMyRank();
  const { data: blocks } = useMyBlocks();
  // only wear a badge once there's a collection behind it
  const badge = rank && rank.visited_count >= 3 ? `TOP ${rank.top_percent}%` : null;

  const share = async () => {
    if (sharing) return;
    setSharing(true);
    try {
      const uri = await captureRef(cardRef, { format: "png", quality: 1, result: "tmpfile" });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: "image/png", dialogTitle: "Share your map" });
      } else {
        Alert.alert("Sharing unavailable", "Sharing isn't available on this device.");
      }
    } catch {
      Alert.alert("Couldn't share", "Something went wrong creating your card.");
    } finally {
      setSharing(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xl * 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Text style={[type.heading, { flexShrink: 1 }]} numberOfLines={1}>
          {profile?.display_name ?? (profile?.handle ? `@${profile.handle}` : session?.user.email)}
        </Text>
        {badge && (
          <View style={styles.rankBadge}>
            <Ionicons name="medal" size={12} color="#1A1A18" />
            <Text style={styles.rankBadgeText}>{badge}</Text>
          </View>
        )}
      </View>
      <Text style={[type.caption, { marginBottom: spacing.md }]}>
        {badge
          ? `You're in the top ${rank?.top_percent}% of collectors — keep going.`
          : `Your ${skin.vocab.place} map, ready to share.`}
      </Text>

      <View ref={cardRef} collapsable={false}>
        <ShareCard logs={logs ?? []} handle={handle} badge={badge} />
      </View>

      <Pressable style={[styles.shareButton, sharing && { opacity: 0.6 }]} onPress={share} disabled={sharing}>
        <Ionicons name="share-outline" size={19} color="#FFF" />
        <Text style={styles.shareText}>{sharing ? "Preparing…" : "Share my card"}</Text>
      </Pressable>

      <Pressable
        style={styles.inviteButton}
        onPress={() =>
          Share.share({
            message: `I'm logging every one of my ${skin.vocab.places} on ${skin.vocab.appName}${handle ? ` — I'm @${handle}` : ""}. Get it and send me your card!`,
          }).catch(() => {})
        }
      >
        <Ionicons name="person-add-outline" size={18} color={colors.primary} />
        <Text style={styles.inviteText}>Invite friends</Text>
      </Pressable>

      <View style={styles.statsCard}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
          <Text style={type.heading}>Your stats</Text>
          {!isPro && <Ionicons name="lock-closed" size={14} color={colors.accent} />}
        </View>
        {isPro ? (
          <StatsByRegion logs={logs ?? []} />
        ) : (
          <Pressable onPress={() => router.push("/paywall")}>
            <Text style={[type.caption, { marginTop: spacing.xs }]}>
              Breakdowns by state and year — unlock with Pro.
            </Text>
          </Pressable>
        )}
      </View>

      {blocks && blocks.length > 0 && (
        <Pressable style={styles.blockedRow} onPress={() => router.push("/blocked")}>
          <Text style={type.caption}>Blocked accounts</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Text style={[type.caption, { color: colors.textSecondary }]}>{blocks.length}</Text>
            <Ionicons name="chevron-forward" size={14} color={colors.textSecondary} />
          </View>
        </Pressable>
      )}

      <Pressable
        style={styles.signOut}
        onPress={() =>
          Alert.alert("Sign out?", undefined, [
            { text: "Cancel", style: "cancel" },
            { text: "Sign out", style: "destructive", onPress: signOut },
          ])
        }
      >
        <Text style={[type.caption, { color: colors.textSecondary }]}>Sign out</Text>
      </Pressable>

      <Pressable
        style={{ alignItems: "center", marginTop: spacing.md }}
        onPress={() =>
          Alert.alert(
            "Delete account?",
            "This permanently deletes your account, logs, lists, and trips. It cannot be undone.",
            [
              { text: "Cancel", style: "cancel" },
              {
                text: "Delete forever",
                style: "destructive",
                onPress: async () => {
                  const supabase = getSupabase();
                  if (!supabase) {
                    Alert.alert("Couldn't delete", "Please try again or contact support.");
                    return;
                  }
                  const { error } = await supabase.functions.invoke("delete-account");
                  if (error) Alert.alert("Couldn't delete", "Please try again or contact support.");
                  else signOut();
                },
              },
            ],
          )
        }
      >
        <Text style={[type.caption, { color: "#B4552D" }]}>Delete account</Text>
      </Pressable>
    </ScrollView>
  );
}

function StatsByRegion({ logs }: { logs: import("../../lib/data").MyLog[] }) {
  const byRegion = new Map<string, number>();
  for (const l of logs) {
    if (l.status !== "visited" || !l.place.region) continue;
    byRegion.set(l.place.region, (byRegion.get(l.place.region) ?? 0) + 1);
  }
  const rows = [...byRegion.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (rows.length === 0) {
    return <Text style={[type.caption, { marginTop: spacing.xs }]}>Log somewhere to see your breakdown.</Text>;
  }
  return (
    <View style={{ marginTop: spacing.sm, gap: 4 }}>
      {rows.map(([region, n]) => (
        <View key={region} style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text style={type.body}>{region}</Text>
          <Text style={[type.body, { fontWeight: "700", color: colors.primary }]}>{n}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  statsCard: {
    backgroundColor: colors.surface,
    borderRadius: 4,
    padding: spacing.md,
    marginTop: spacing.lg,
  },
  shareButton: {
    flexDirection: "row",
    gap: spacing.xs,
    marginTop: spacing.md,
    height: 50,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
  },
  shareText: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
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
  inviteButton: {
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
  inviteText: { color: colors.primary, fontSize: 15, fontWeight: "700" },
  blockedRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.lg,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.hairline,
    backgroundColor: colors.surface,
  },
  signOut: { alignItems: "center", marginTop: spacing.xl },
});
