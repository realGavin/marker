import React, { useEffect, useState } from "react";
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { skin } from "../../skin";
import { colors, spacing, type } from "../../ui/theme";
import { getSupabase } from "../../lib/supabase";

interface PlaceDetail {
  slug: string;
  name: string;
  city: string | null;
  region: string | null;
  attrs: unknown;
  description: string | null;
}

export default function PlaceScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const [place, setPlace] = useState<PlaceDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase || !slug) return setState("error");
    supabase
      .from("places")
      .select("slug,name,city,region,attrs,description")
      .eq("niche_id", skin.nicheId)
      .eq("slug", slug)
      .single()
      .then(({ data, error }) => {
        if (error || !data) setState("error");
        else {
          setPlace(data as PlaceDetail);
          setState("ready");
        }
      });
  }, [slug]);

  if (state === "loading") {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (state === "error" || !place) {
    return (
      <View style={styles.center}>
        <Text style={type.body}>Couldn't load this {skin.vocab.place}.</Text>
        <Text style={[type.caption, { marginTop: spacing.xs }]}>Check your connection and try again.</Text>
      </View>
    );
  }

  const facts = skin.attributeFacts(place.attrs);
  const website = (place.attrs as { website?: string } | null)?.website;
  const location = [place.city, place.region].filter(Boolean).join(", ");

  return (
    <>
      <Stack.Screen options={{ title: place.name, headerBackTitle: "Map" }} />
      <ScrollView style={styles.container} contentContainerStyle={{ padding: spacing.md }}>
        <Text style={type.title}>{place.name}</Text>
        {location ? <Text style={[type.caption, { marginTop: spacing.xs }]}>{location}</Text> : null}

        {facts.length > 0 && (
          <View style={styles.card}>
            {facts.map((f) => (
              <View key={f.label} style={styles.factRow}>
                <Text style={[type.caption, { width: 100 }]}>{f.label}</Text>
                <Text style={type.body}>{f.value}</Text>
              </View>
            ))}
          </View>
        )}

        <View style={styles.card}>
          <Text style={type.body}>
            {place.description ?? "Description coming soon."}
          </Text>
        </View>

        {website ? (
          <Pressable style={styles.button} onPress={() => Linking.openURL(website)}>
            <Text style={styles.buttonText}>Visit website</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background, padding: spacing.lg },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  factRow: { flexDirection: "row", alignItems: "center", paddingVertical: spacing.xs },
  button: {
    marginTop: spacing.md,
    height: 48,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
  },
  buttonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
});
