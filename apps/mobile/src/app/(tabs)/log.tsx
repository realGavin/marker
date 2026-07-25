import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { skin } from "../../skin";
import { colors, spacing, type } from "../../ui/theme";

/** Collection tab — the user's visited/want log arrives in M3. */
export default function LogScreen() {
  return (
    <View style={styles.container}>
      <Text style={type.heading}>{skin.vocab.myPlaces}</Text>
      <Text style={[type.caption, { marginTop: spacing.sm, textAlign: "center" }]}>
        Everything you log lands here (M3).
      </Text>
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
});
