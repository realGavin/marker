import React from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import { colors, spacing, type } from "../../ui/theme";
import { useListItems, useLists, useMyLogs } from "../../lib/data";

export default function ListScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { data: lists } = useLists();
  const { data: items, isPending } = useListItems(id ?? "");
  const { data: logs } = useMyLogs();

  const list = lists?.find((l) => l.id === id);
  const visitedIds = new Set((logs ?? []).filter((l) => l.status === "visited").map((l) => l.place_id));
  const done = (items ?? []).filter((i) => visitedIds.has(i.place.id)).length;

  if (isPending) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: list?.title ?? "List" }} />
      <FlatList
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={{ padding: spacing.md }}
        data={items ?? []}
        keyExtractor={(i) => i.place.id}
        ListHeaderComponent={
          <View style={{ marginBottom: spacing.md }}>
            <Text style={type.title}>{list?.title}</Text>
            {list?.description ? (
              <Text style={[type.caption, { marginTop: spacing.xs }]}>{list.description}</Text>
            ) : null}
            <Text style={[type.heading, { marginTop: spacing.sm, color: colors.primary }]}>
              {done}/{items?.length ?? 0}
            </Text>
          </View>
        }
        renderItem={({ item }) => {
          const visited = visitedIds.has(item.place.id);
          return (
            <Pressable style={styles.row} onPress={() => router.push(`/place/${item.place.slug}`)}>
              <Ionicons
                name={visited ? "checkmark-circle" : "ellipse-outline"}
                size={22}
                color={visited ? colors.primary : colors.textSecondary}
              />
              <View style={{ flex: 1, marginLeft: spacing.sm }}>
                <Text style={[type.body, visited && { color: colors.primary, fontWeight: "600" }]} numberOfLines={1}>
                  {item.place.name}
                </Text>
                <Text style={type.caption}>
                  {[item.place.city, item.place.region].filter(Boolean).join(", ")}
                </Text>
              </View>
            </Pressable>
          );
        }}
        ListEmptyComponent={
          <Text style={[type.caption, { textAlign: "center", marginTop: spacing.xl }]}>
            This list is empty.
          </Text>
        }
      />
    </>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background },
  row: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
});
