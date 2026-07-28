import React, { useState } from "react";
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import { colors, spacing, type } from "../../ui/theme";
import { useCreateList, useDeleteList, useListItems, useLists, useMyLogs, useRenameList } from "../../lib/data";
import { usePurchases } from "../../providers/purchases";

const FREE_LIST_LIMIT = 3;

export default function ListsScreen() {
  const router = useRouter();
  const { data: lists, isPending } = useLists();
  const { data: logs } = useMyLogs();
  const createList = useCreateList();
  const deleteList = useDeleteList();
  const renameList = useRenameList();
  const [creating, setCreating] = useState(false);

  /** Rename / Delete menu for a list the user owns. */
  const manageList = (id: string, title: string) =>
    Alert.alert(title, undefined, [
      {
        text: "Rename",
        onPress: () =>
          Alert.prompt("Rename list", undefined, (next) => {
            if (next?.trim()) renameList.mutate({ listId: id, title: next.trim() });
          }, "plain-text", title),
      },
      {
        text: "Delete list",
        style: "destructive",
        onPress: () =>
          Alert.alert("Delete list?", `"${title}" and its contents will be removed.`, [
            { text: "Cancel", style: "cancel" },
            { text: "Delete", style: "destructive", onPress: () => deleteList.mutate(id) },
          ]),
      },
      { text: "Cancel", style: "cancel" },
    ]);

  const visitedIds = new Set((logs ?? []).filter((l) => l.status === "visited").map((l) => l.place_id));

  const curated = (lists ?? []).filter((l) => l.owner_id === null);
  const mine = (lists ?? []).filter((l) => l.owner_id !== null);

  const { isPro } = usePurchases();

  const onCreate = () => {
    if (creating) return;
    if (!isPro && mine.length >= FREE_LIST_LIMIT) {
      router.push("/paywall");
      return;
    }
    Alert.prompt("New list", "Name your list", (title) => {
      if (title?.trim()) {
        setCreating(true);
        createList.mutate(title.trim(), { onSettled: () => setCreating(false) });
      }
    });
  };

  return (
    <FlatList
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xl * 2 }}
      data={[...curated, ...mine]}
      keyExtractor={(l) => l.id}
      ListHeaderComponent={
        <View style={styles.headerRow}>
          <Text style={type.heading}>Bucket lists</Text>
          <Pressable style={styles.newButton} onPress={onCreate}>
            <Ionicons name="add" size={18} color="#FFF" />
            <Text style={styles.newButtonText}>New list</Text>
          </Pressable>
        </View>
      }
      renderItem={({ item }) => (
        <ListCard
          id={item.id}
          title={item.title}
          description={item.description}
          curated={item.owner_id === null}
          itemCount={item.itemCount}
          visitedIds={visitedIds}
          onPress={() => router.push(`/list/${item.id}`)}
          onManage={item.owner_id === null ? undefined : () => manageList(item.id, item.title)}
        />
      )}
      ListEmptyComponent={
        <Text style={[type.caption, { textAlign: "center", marginTop: spacing.xl }]}>
          {isPending ? "Loading…" : "No lists yet."}
        </Text>
      }
    />
  );
}

function ListCard(props: {
  id: string;
  title: string;
  description: string | null;
  curated: boolean;
  itemCount: number;
  visitedIds: Set<string>;
  onPress: () => void;
  onManage?: () => void;
}) {
  const { data: items } = useListItems(props.id);
  const done = (items ?? []).filter((i) => props.visitedIds.has(i.place.id)).length;
  const total = props.itemCount || (items?.length ?? 0);
  const pct = total > 0 ? Math.min(1, done / total) : 0;

  return (
    <Pressable style={styles.card} onPress={props.onPress} onLongPress={props.onManage}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
        {props.curated && <Ionicons name="ribbon" size={16} color={colors.accent} />}
        <Text style={[type.heading, { flex: 1 }]} numberOfLines={1}>{props.title}</Text>
        {props.onManage && (
          <Pressable onPress={props.onManage} hitSlop={10}>
            <Ionicons name="ellipsis-horizontal" size={20} color={colors.textSecondary} />
          </Pressable>
        )}
      </View>
      {props.description ? (
        <Text style={[type.caption, { marginTop: spacing.xs }]} numberOfLines={2}>{props.description}</Text>
      ) : null}
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { flex: pct }]} />
        <View style={{ flex: 1 - pct }} />
      </View>
      <Text style={type.caption}>{done}/{total}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.md },
  newButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: colors.primary,
    borderRadius: 8,
    paddingHorizontal: spacing.sm,
    height: 34,
  },
  newButtonText: { color: "#FFF", fontWeight: "600", fontSize: 14 },
  card: { backgroundColor: colors.surface, borderRadius: 12, padding: spacing.md, marginBottom: spacing.sm },
  progressTrack: {
    flexDirection: "row",
    height: 6,
    borderRadius: 3,
    backgroundColor: "#E9E4D8",
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
    overflow: "hidden",
  },
  progressFill: { backgroundColor: colors.primary, borderRadius: 3 },
});
