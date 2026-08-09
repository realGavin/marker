import React from "react";
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { Stack } from "expo-router";
import { colors, spacing, type } from "../ui/theme";
import { useMyBlocks, useUnblockUser, type BlockedAccount } from "../lib/data";

export default function BlockedScreen() {
  const { data: blocks } = useMyBlocks();
  const unblockUser = useUnblockUser();

  const confirmUnblock = (account: BlockedAccount) => {
    const label = account.handle ? `@${account.handle}` : "this account";
    Alert.alert(`Unblock ${label}?`, "You'll see their published trips again.", [
      { text: "Cancel", style: "cancel" },
      { text: "Unblock", style: "destructive", onPress: () => unblockUser.mutate(account.blocked_id) },
    ]);
  };

  return (
    <>
      <Stack.Screen options={{ title: "Blocked accounts", headerBackTitle: "Back" }} />
      <FlatList
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={{ padding: spacing.md, flexGrow: 1 }}
        data={blocks ?? []}
        keyExtractor={(item) => item.blocked_id}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Text style={type.body} numberOfLines={1}>
              {item.handle ? `@${item.handle}` : "Account"}
            </Text>
            <Pressable
              style={styles.unblockButton}
              disabled={unblockUser.isPending}
              onPress={() => confirmUnblock(item)}
            >
              <Text style={styles.unblockText}>Unblock</Text>
            </Pressable>
          </View>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={type.caption}>You haven't blocked anyone.</Text>
          </View>
        }
      />
    </>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.surface,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: colors.hairline,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  unblockButton: {
    borderWidth: 1.5,
    borderColor: "#B4552D",
    borderRadius: 3,
    paddingHorizontal: spacing.sm,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  unblockText: { fontSize: 13, fontWeight: "700", color: "#B4552D" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", marginTop: spacing.xl },
});
