import React from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import { skin } from "../../skin";
import { colors, spacing, type } from "../../ui/theme";

/** Lists tab — curated lists from the skin; DB-backed progress arrives in M3. */
export default function ListsScreen() {
  return (
    <FlatList
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={{ padding: spacing.md }}
      data={skin.curatedLists}
      keyExtractor={(l) => l.slug}
      renderItem={({ item }) => (
        <View style={styles.card}>
          <Text style={type.heading}>{item.title}</Text>
          <Text style={[type.caption, { marginTop: spacing.xs }]}>{item.description}</Text>
        </View>
      )}
      ListEmptyComponent={
        <Text style={[type.caption, { textAlign: "center", marginTop: spacing.xl }]}>
          No lists yet.
        </Text>
      }
    />
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
});
