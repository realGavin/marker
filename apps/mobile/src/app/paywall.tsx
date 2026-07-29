import React, { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Purchases, { type PurchasesPackage } from "react-native-purchases";
import { Stack, useRouter } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import { skin } from "../skin";
import { usePurchases } from "../providers/purchases";
import { colors, spacing, type } from "../ui/theme";

const PERKS: Array<{ icon: string; text: string }> = [
  { icon: "list", text: "Unlimited personal lists" },
  { icon: "stats-chart", text: "Your stats, by state and year" },
  { icon: "airplane", text: "Trip Planner: real itineraries, built for you" },
  { icon: "cloud-offline", text: "Offline maps for your trips" },
];

export default function PaywallScreen() {
  const router = useRouter();
  const { refresh } = usePurchases();
  const [packages, setPackages] = useState<PurchasesPackage[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Purchases.getOfferings()
      .then((o) => setPackages(o.current?.availablePackages ?? []))
      .catch(() => setPackages([]));
  }, []);

  const buy = async (pkg: PurchasesPackage) => {
    if (busy) return;
    setBusy(true);
    try {
      await Purchases.purchasePackage(pkg);
      await refresh();
      router.back();
    } catch (e: unknown) {
      const err = e as { userCancelled?: boolean };
      if (!err.userCancelled) Alert.alert("Purchase failed", "Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    setBusy(true);
    try {
      await Purchases.restorePurchases();
      await refresh();
      router.back();
    } catch {
      Alert.alert("Nothing to restore", "No previous purchase was found.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Stack.Screen options={{ presentation: "modal", headerShown: false }} />
      <ScrollView style={styles.container} contentContainerStyle={{ padding: spacing.lg }}>
        <Pressable style={styles.close} onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="close" size={24} color={colors.textSecondary} />
        </Pressable>

        <Text style={[type.title, { marginTop: spacing.xl }]}>
          {skin.vocab.appName} Pro
        </Text>
        <Text style={[type.caption, { marginTop: spacing.xs, marginBottom: spacing.lg }]}>
          The complete collector's toolkit.
        </Text>

        {PERKS.map((p) => (
          <View key={p.text} style={styles.perkRow}>
            <Ionicons name={p.icon as never} size={20} color={colors.primary} />
            <Text style={type.body}>{p.text}</Text>
          </View>
        ))}

        <View style={{ marginTop: spacing.xl, gap: spacing.sm }}>
          {packages === null ? (
            <ActivityIndicator color={colors.primary} />
          ) : packages.length === 0 ? (
            <Text style={[type.caption, { textAlign: "center" }]}>
              Plans aren't available right now. Try again later.
            </Text>
          ) : (
            packages.map((pkg) => (
              <Pressable
                key={pkg.identifier}
                style={[styles.planButton, pkg.packageType === "ANNUAL" && styles.planPrimary, busy && { opacity: 0.6 }]}
                onPress={() => buy(pkg)}
                disabled={busy}
              >
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text style={[styles.planTitle, pkg.packageType === "ANNUAL" && { color: "#FFF" }]}>
                    {pkg.packageType === "ANNUAL" ? "Annual" : pkg.packageType === "MONTHLY" ? "Monthly" : pkg.product.title}
                  </Text>
                  {pkg.packageType === "ANNUAL" && (
                    <View style={styles.saveBadge}>
                      <Text style={styles.saveBadgeText}>SAVE 44%</Text>
                    </View>
                  )}
                </View>
                <Text style={[styles.planPrice, pkg.packageType === "ANNUAL" && { color: "#FFF" }]}>
                  {pkg.product.priceString}
                  {pkg.packageType === "ANNUAL" ? " / year" : pkg.packageType === "MONTHLY" ? " / month" : ""}
                </Text>
              </Pressable>
            ))
          )}
        </View>

        <Pressable onPress={restore} disabled={busy} style={{ marginTop: spacing.lg }}>
          <Text style={[type.caption, { textAlign: "center" }]}>Restore purchase</Text>
        </Pressable>

        <Text style={[type.caption, styles.legalNote]}>
          Subscriptions renew automatically until cancelled in your App Store settings.
        </Text>
        <View style={styles.legalRow}>
          <Pressable onPress={() => Linking.openURL("https://marker-tiles.shuozeng21.workers.dev/privacy")}>
            <Text style={styles.legalLink}>Privacy Policy</Text>
          </Pressable>
          <Text style={type.caption}>·</Text>
          <Pressable onPress={() => Linking.openURL("https://www.apple.com/legal/internet-services/itunes/dev/stdeula/")}>
            <Text style={styles.legalLink}>Terms of Use</Text>
          </Pressable>
        </View>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  close: { position: "absolute", top: spacing.md, right: spacing.md, zIndex: 1 },
  perkRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.sm },
  planButton: {
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: colors.primary,
    padding: spacing.md,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    backgroundColor: colors.surface,
  },
  planPrimary: { backgroundColor: colors.primary },
  planTitle: { fontSize: 16, fontWeight: "700", color: colors.textPrimary },
  saveBadge: { backgroundColor: colors.accent, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
  saveBadgeText: { fontSize: 10, fontWeight: "800", color: "#1A1A18", letterSpacing: 0.5 },
  planPrice: { fontSize: 15, fontWeight: "600", color: colors.textPrimary },
  legalNote: { textAlign: "center", marginTop: spacing.lg },
  legalRow: {
    flexDirection: "row",
    gap: spacing.xs,
    alignItems: "center",
    justifyContent: "center",
    marginTop: spacing.xs,
    marginBottom: spacing.lg,
  },
  legalLink: { fontSize: 12, color: colors.primary, textDecorationLine: "underline" },
});
