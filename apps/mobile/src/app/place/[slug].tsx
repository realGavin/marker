import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import { skin } from "../../skin";
import { colors, spacing, type } from "../../ui/theme";
import * as Haptics from "expo-haptics";
import {
  usePlace,
  useMyLogs,
  useUpsertLog,
  useDeleteLog,
  useSimilarPlaces,
  useLists,
  useAddToList,
  useCreateList,
} from "../../lib/data";
import { useRouter } from "expo-router";

/** Rating stored as 0–20 (half steps); shown as 0–10. */
const shownRating = (r: number) => (r / 2).toFixed(r % 2 ? 1 : 0);

export default function PlaceScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const router = useRouter();
  const { data: place, isPending, isError } = usePlace(slug ?? "");
  const { data: similar } = useSimilarPlaces(place?.id);
  const { data: logs } = useMyLogs();
  const upsert = useUpsertLog();
  const remove = useDeleteLog();
  const { data: allLists } = useLists();
  const addToList = useAddToList();
  const createList = useCreateList();
  const [listPickerOpen, setListPickerOpen] = useState(false);
  const myLists = (allLists ?? []).filter((l) => l.owner_id !== null);

  const myLog = logs?.find((l) => l.place.slug === slug);
  const [note, setNote] = useState("");
  const [rating, setRating] = useState<number | null>(null);

  useEffect(() => {
    setNote(myLog?.note ?? "");
    setRating(myLog?.rating ?? null);
  }, [myLog?.note, myLog?.rating]);

  if (isPending) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (isError || !place) {
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
  const status = myLog?.status;

  const setStatus = (next: "visited" | "want") => {
    if (status === next) {
      remove.mutate(place.id);
    } else {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      upsert.mutate({ placeId: place.id, status: next, rating, note: note || null });
    }
  };

  const saveDetails = (r: number | null) => {
    setRating(r);
    if (status === "visited") {
      upsert.mutate({ placeId: place.id, status: "visited", rating: r, note: note || null });
    }
  };

  return (
    <>
      <Stack.Screen options={{ title: place.name, headerBackTitle: "Back" }} />
      <ScrollView style={styles.container} contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xl * 2 }}>
        <Text style={type.title}>{place.name}</Text>
        {location ? <Text style={[type.caption, { marginTop: spacing.xs }]}>{location}</Text> : null}

        <View style={styles.statusRow}>
          <Pressable
            style={[styles.statusButton, status === "visited" && styles.statusActive]}
            onPress={() => setStatus("visited")}
            disabled={upsert.isPending || remove.isPending}
          >
            <Ionicons name={status === "visited" ? "checkmark-circle" : "checkmark-circle-outline"} size={20} color={status === "visited" ? "#FFF" : colors.primary} />
            <Text style={[styles.statusText, status === "visited" && { color: "#FFF" }]}>{skin.vocab.visited}</Text>
          </Pressable>
          <Pressable
            style={[styles.statusButton, status === "want" && styles.statusActiveWant]}
            onPress={() => setStatus("want")}
            disabled={upsert.isPending || remove.isPending}
          >
            <Ionicons name={status === "want" ? "bookmark" : "bookmark-outline"} size={18} color={status === "want" ? "#FFF" : colors.accent} />
            <Text style={[styles.statusText, { color: status === "want" ? "#FFF" : colors.accent }]}>{skin.vocab.wantTo}</Text>
          </Pressable>
        </View>

        <Pressable style={styles.addToList} onPress={() => setListPickerOpen(!listPickerOpen)}>
          <Ionicons name="albums-outline" size={18} color={colors.primary} />
          <Text style={styles.addToListText}>Add to a list</Text>
          <Ionicons name={listPickerOpen ? "chevron-up" : "chevron-down"} size={15} color={colors.textSecondary} />
        </Pressable>
        {listPickerOpen && (
          <View style={styles.card}>
            {myLists.map((l) => (
              <Pressable
                key={l.id}
                style={styles.listRow}
                onPress={() => {
                  addToList.mutate({ listId: l.id, placeId: place.id });
                  setListPickerOpen(false);
                  Haptics.selectionAsync().catch(() => {});
                }}
              >
                <Ionicons name="list" size={16} color={colors.primary} />
                <Text style={type.body}>{l.title}</Text>
              </Pressable>
            ))}
            <Pressable
              style={styles.listRow}
              onPress={() => {
                Alert.prompt("New list", "Name your list", (title) => {
                  if (title?.trim()) {
                    createList.mutate(title.trim());
                  }
                });
              }}
            >
              <Ionicons name="add" size={16} color={colors.accent} />
              <Text style={[type.body, { color: colors.accent }]}>New list…</Text>
            </Pressable>
          </View>
        )}

        {status === "visited" && (
          <View style={styles.card}>
            <Text style={type.heading}>Your rating</Text>
            <View style={styles.ratingRow}>
              {[2, 4, 6, 8, 10, 12, 14, 16, 18, 20].map((r) => (
                <Pressable key={r} onPress={() => saveDetails(rating === r ? null : r)} hitSlop={4}>
                  <Ionicons
                    name={rating != null && rating >= r ? "star" : "star-outline"}
                    size={26}
                    color={colors.accent}
                  />
                </Pressable>
              ))}
            </View>
            {rating != null && <Text style={type.caption}>{shownRating(rating)} / 10</Text>}
            <TextInput
              style={styles.noteInput}
              placeholder="Add a note…"
              placeholderTextColor={colors.textSecondary}
              value={note}
              onChangeText={setNote}
              onEndEditing={() => upsert.mutate({ placeId: place.id, status: "visited", rating, note: note || null })}
              multiline
            />
          </View>
        )}

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
          <Text style={type.body}>{place.description ?? "Description coming soon."}</Text>
        </View>

        {website ? (
          <Pressable style={styles.button} onPress={() => Linking.openURL(website)}>
            <Text style={styles.buttonText}>Visit website</Text>
          </Pressable>
        ) : null}

        {similar && similar.length > 0 && (
          <View style={styles.card}>
            <Text style={type.heading}>Similar {skin.vocab.places}</Text>
            {similar.map((s) => (
              <Pressable
                key={s.id}
                style={styles.similarRow}
                onPress={() => router.push(`/place/${s.slug}`)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={type.body} numberOfLines={1}>{s.name}</Text>
                  <Text style={type.caption}>
                    {[s.city, s.region].filter(Boolean).join(", ")}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background, padding: spacing.lg },
  statusRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  statusButton: {
    flex: 1,
    flexDirection: "row",
    gap: spacing.xs,
    height: 44,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
  },
  statusActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  statusActiveWant: { backgroundColor: colors.accent, borderColor: colors.accent },
  statusText: { fontSize: 15, fontWeight: "600", color: colors.primary },
  ratingRow: { flexDirection: "row", gap: 4, marginVertical: spacing.sm },
  noteInput: {
    marginTop: spacing.sm,
    minHeight: 60,
    borderWidth: 1,
    borderColor: "#DDD8CC",
    borderRadius: 8,
    padding: spacing.sm,
    color: colors.textPrimary,
    backgroundColor: colors.background,
  },
  card: { backgroundColor: colors.surface, borderRadius: 12, padding: spacing.md, marginTop: spacing.md },
  addToList: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    marginTop: spacing.sm,
    alignSelf: "flex-start",
    paddingVertical: spacing.xs,
  },
  addToListText: { fontSize: 14, fontWeight: "600", color: colors.primary },
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  similarRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#EEE9DD",
    marginTop: spacing.xs,
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
