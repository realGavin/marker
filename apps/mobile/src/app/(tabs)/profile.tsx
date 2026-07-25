import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../providers/auth";
import { colors, spacing, type } from "../../ui/theme";

export default function ProfileScreen() {
  const { session, signOut } = useAuth();

  return (
    <View style={styles.container}>
      <Text style={type.heading}>{session?.user.email ?? "Signed in"}</Text>
      <Text style={[type.caption, { marginTop: spacing.sm }]}>
        Share card, trips, and settings arrive in M5–M7.
      </Text>
      <Pressable style={styles.button} onPress={signOut}>
        <Text style={styles.buttonText}>Sign out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.lg,
    backgroundColor: colors.background,
  },
  button: {
    marginTop: spacing.xl,
    paddingHorizontal: spacing.lg,
    height: 44,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
  },
  buttonText: { color: "#FFFFFF", fontWeight: "600" },
});
