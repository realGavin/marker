import React, { useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { captureRef } from "react-native-view-shot";
import * as Sharing from "expo-sharing";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import { useAuth } from "../../providers/auth";
import { usePurchases } from "../../providers/purchases";
import { useMyLogs, useProfile } from "../../lib/data";
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
      <Text style={type.heading}>{profile?.display_name ?? session?.user.email}</Text>
      <Text style={[type.caption, { marginBottom: spacing.md }]}>
        Your {skin.vocab.place} map, ready to share.
      </Text>

      <View ref={cardRef} collapsable={false}>
        <ShareCard logs={logs ?? []} handle={handle} />
      </View>

      <Pressable style={[styles.shareButton, sharing && { opacity: 0.6 }]} onPress={share} disabled={sharing}>
        <Ionicons name="share-outline" size={19} color="#FFF" />
        <Text style={styles.shareText}>{sharing ? "Preparing…" : "Share my map"}</Text>
      </Pressable>

      <Pressable style={styles.tripsRow} onPress={() => router.push("/trips")}>
        <Ionicons name="airplane" size={20} color={colors.primary} />
        <Text style={[type.body, { flex: 1, fontWeight: "600" }]}>{skin.vocab.planTrip}</Text>
        <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
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

      <Pressable style={styles.signOut} onPress={signOut}>
        <Text style={[type.caption, { color: colors.textSecondary }]}>Sign out</Text>
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
    borderRadius: 12,
    padding: spacing.md,
    marginTop: spacing.lg,
  },
  tripsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    marginTop: spacing.lg,
  },
  shareButton: {
    flexDirection: "row",
    gap: spacing.xs,
    marginTop: spacing.md,
    height: 50,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
  },
  shareText: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
  signOut: { alignItems: "center", marginTop: spacing.xl },
});
