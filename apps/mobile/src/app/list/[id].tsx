import React from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, Share, StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useAuth } from "../../providers/auth";
import { skin } from "../../skin";
import { colors, spacing, type } from "../../ui/theme";
import { useListItems, useLists, useMyLogs, useRemoveFromList } from "../../lib/data";

export default function ListScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const { data: lists } = useLists();
  const { data: items, isPending } = useListItems(id ?? "");
  const { data: logs } = useMyLogs();
  const removeFromList = useRemoveFromList();

  const list = lists?.find((l) => l.id === id);
  const isMine = list?.owner_id != null && list.owner_id === session?.user.id;
  const visitedIds = new Set((logs ?? []).filter((l) => l.status === "visited").map((l) => l.place_id));
  const done = (items ?? []).filter((i) => visitedIds.has(i.place.id)).length;

  const shareList = () => {
    if (!list) return;
    const lines = [`${list.title} — ${skin.vocab.appName}`];
    if (list.description) lines.push(list.description);
    lines.push(`${done}/${items?.length ?? 0} ${skin.vocab.visited.toLowerCase()}`, "");
    for (const i of items ?? []) {
      const where = [i.place.city, i.place.region].filter(Boolean).join(", ");
      lines.push(`${visitedIds.has(i.place.id) ? "✓" : "•"} ${i.place.name}${where ? ` (${where})` : ""}`);
    }
    Share.share({ message: lines.join("\n") }).catch(() => {});
  };

  const removeItem = (placeId: string, name: string) =>
    Alert.alert("Remove from list?", name, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => id && removeFromList.mutate({ listId: id, placeId }),
      },
    ]);

  if (isPending) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: list?.title ?? "List",
          headerRight: () => (
            <Pressable onPress={shareList} hitSlop={10}>
              <Ionicons name="share-outline" size={22} color={colors.primary} />
            </Pressable>
          ),
        }}
      />
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
              {isMine && (
                <Pressable onPress={() => removeItem(item.place.id, item.place.name)} hitSlop={10}>
                  <Ionicons name="close-circle-outline" size={20} color={colors.textSecondary} />
                </Pressable>
              )}
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
    borderRadius: 4,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
});
