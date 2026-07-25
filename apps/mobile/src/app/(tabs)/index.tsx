import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { skin } from "../../skin";
import { colors, spacing, type } from "../../ui/theme";

/** Map tab — MapLibre + clustered pins arrive in M2. */
export default function MapScreen() {
  return (
    <View style={styles.container}>
      <Text style={type.heading}>The map is coming in M2</Text>
      <Text style={[type.caption, { marginTop: spacing.sm, textAlign: "center" }]}>
        Every {skin.vocab.place} in the country, self-hosted, no metered APIs.
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
