import React, { useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import { skin } from "../../skin";
import { colors, spacing, type } from "../../ui/theme";
import { useMyLogs } from "../../lib/data";

const shownRating = (r: number) => (r / 2).toFixed(r % 2 ? 1 : 0);

export default function LogScreen() {
  const router = useRouter();
  const { data: logs, isPending } = useMyLogs();
  const [tab, setTab] = useState<"visited" | "want">("visited");
  const [sort, setSort] = useState<"recent" | "name" | "rating">("recent");

  const rows = (logs ?? [])
    .filter((l) => l.status === tab)
    .sort((a, b) => {
      if (sort === "name") return a.place.name.localeCompare(b.place.name);
      if (sort === "rating") return (b.rating ?? -1) - (a.rating ?? -1);
      return 0; // server order is already most-recent-first
    });

  return (
    <View style={styles.container}>
      <View style={styles.segment}>
        {(["visited", "want"] as const).map((t) => (
          <Pressable
            key={t}
            style={[styles.segmentButton, tab === t && styles.segmentActive]}
            onPress={() => setTab(t)}
          >
            <Text style={[styles.segmentText, tab === t && { color: "#FFF" }]}>
              {t === "visited" ? skin.vocab.visited : skin.vocab.wantTo}
              {logs ? ` (${(logs ?? []).filter((l) => l.status === t).length})` : ""}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.sortRow}>
        {(["recent", "name", "rating"] as const).map((s) => (
          <Pressable key={s} onPress={() => setSort(s)}>
            <Text style={[styles.sortText, sort === s && { color: colors.primary, fontWeight: "700" }]}>
              {s === "recent" ? "Recent" : s === "name" ? "A-Z" : "Top rated"}
            </Text>
          </Pressable>
        ))}
      </View>

      <FlatList
        contentContainerStyle={{ padding: spacing.md, paddingTop: 0 }}
        data={rows}
        keyExtractor={(l) => l.place_id}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => router.push(`/place/${item.place.slug}`)}>
            <View style={{ flex: 1 }}>
              <Text style={type.body} numberOfLines={1}>{item.place.name}</Text>
              <Text style={type.caption}>
                {[item.place.city, item.place.region].filter(Boolean).join(", ")}
              </Text>
            </View>
            {item.rating != null && (
              <View style={styles.rating}>
                <Ionicons name="star" size={14} color={colors.accent} />
                <Text style={[type.caption, { color: colors.textPrimary }]}>{shownRating(item.rating)}</Text>
              </View>
            )}
          </Pressable>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name={tab === "visited" ? "flag-outline" : "bookmark-outline"} size={36} color={colors.textSecondary} />
            <Text style={[type.body, { marginTop: spacing.sm }]}>
              {isPending ? "Loading…" : "Nothing here yet."}
            </Text>
            <Text style={[type.caption, { marginTop: spacing.xs, textAlign: "center" }]}>
              Find a {skin.vocab.place} on the map and mark it.
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  segment: {
    flexDirection: "row",
    margin: spacing.md,
    marginBottom: 0,
    backgroundColor: colors.surface,
    borderRadius: 3,
    padding: 3,
  },
  segmentButton: { flex: 1, height: 38, borderRadius: 3, alignItems: "center", justifyContent: "center" },
  segmentActive: { backgroundColor: colors.primary },
  segmentText: { fontSize: 14, fontWeight: "600", color: colors.textPrimary },
  sortRow: { flexDirection: "row", gap: spacing.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  sortText: { fontSize: 13, color: colors.textSecondary },
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: 4,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  rating: { flexDirection: "row", alignItems: "center", gap: 4 },
  empty: { alignItems: "center", marginTop: spacing.xl * 2, paddingHorizontal: spacing.lg },
});
