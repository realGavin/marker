import React, { useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { captureRef } from "react-native-view-shot";
import * as Sharing from "expo-sharing";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useAuth } from "../../providers/auth";
import { useMyLogs, useProfile } from "../../lib/data";
import { ShareCard } from "../../ui/ShareCard";
import { skin } from "../../skin";
import { colors, spacing, type } from "../../ui/theme";

export default function ProfileScreen() {
  const { session, signOut } = useAuth();
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

      <Pressable style={styles.signOut} onPress={signOut}>
        <Text style={[type.caption, { color: colors.textSecondary }]}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
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
