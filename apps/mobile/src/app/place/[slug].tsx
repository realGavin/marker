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
import DateTimePicker from "@react-native-community/datetimepicker";
import { PlacePhoto } from "../../ui/PlacePhoto";
import { scheduleVisitReminders, cancelVisitReminders } from "../../lib/reminders";
import { useVisitTimes, useAddVisitTime, useDeleteVisitTime } from "../../lib/data";

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
  const { data: visitTimes } = useVisitTimes();
  const addVisitTime = useAddVisitTime();
  const deleteVisitTime = useDeleteVisitTime();
  const [timePickerOpen, setTimePickerOpen] = useState(false);
  const [draftTime, setDraftTime] = useState<Date>(() => {
    const d = new Date(Date.now() + 24 * 3600_000);
    d.setMinutes(0, 0, 0);
    return d;
  });

  const myLog = logs?.find((l) => l.place.slug === slug);
  const [note, setNote] = useState("");
  const [rating, setRating] = useState<number | null>(null);
  const [noteSaved, setNoteSaved] = useState(false);

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
  const myVisitTimes = (visitTimes ?? []).filter(
    (v) => v.place.id === place.id && new Date(v.at).getTime() > Date.now(),
  );

  const confirmVisitTime = async () => {
    try {
      const id = await addVisitTime.mutateAsync({ placeId: place.id, at: draftTime });
      setTimePickerOpen(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      const granted = await scheduleVisitReminders(id, place.name, draftTime);
      if (!granted) {
        Alert.alert(
          "Reminders off",
          `Saved, but notifications are disabled — enable them in Settings to get reminded 24h and 4h before your ${skin.vocab.visitTime.toLowerCase()}.`,
        );
      }
    } catch {
      Alert.alert("Couldn't save", "Please try again.");
    }
  };

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
        <PlacePhoto slug={place.slug} height={190} style={{ marginBottom: spacing.md }} />
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
                Alert.prompt("New list", "Name your list", async (title) => {
                  if (!title?.trim()) return;
                  // create AND add this place in one step — no dead-end picker reopen
                  try {
                    const listId = await createList.mutateAsync(title.trim());
                    addToList.mutate({ listId, placeId: place.id });
                    setListPickerOpen(false);
                    Haptics.selectionAsync().catch(() => {});
                  } catch {
                    Alert.alert("Couldn't create list", "Please try again.");
                  }
                });
              }}
            >
              <Ionicons name="add" size={16} color={colors.accent} />
              <Text style={[type.body, { color: colors.accent }]}>New list…</Text>
            </Pressable>
          </View>
        )}

        <Pressable style={styles.addToList} onPress={() => setTimePickerOpen(!timePickerOpen)}>
          <Ionicons name="alarm-outline" size={18} color={colors.primary} />
          <Text style={styles.addToListText}>{skin.vocab.setVisitTime}</Text>
          <Ionicons name={timePickerOpen ? "chevron-up" : "chevron-down"} size={15} color={colors.textSecondary} />
        </Pressable>
        {timePickerOpen && (
          <View style={styles.card}>
            <DateTimePicker
              value={draftTime}
              mode="datetime"
              display="spinner"
              minimumDate={new Date()}
              minuteInterval={10}
              onChange={(_e, d) => d && setDraftTime(d)}
            />
            <Pressable
              style={[styles.button, addVisitTime.isPending && { opacity: 0.6 }]}
              disabled={addVisitTime.isPending}
              onPress={confirmVisitTime}
            >
              <Text style={styles.buttonText}>
                Remind me 24h & 4h before
              </Text>
            </Pressable>
          </View>
        )}
        {myVisitTimes.length > 0 && (
          <View style={styles.card}>
            <Text style={type.heading}>{skin.vocab.visitTimes}</Text>
            {myVisitTimes.map((v) => (
              <View key={v.id} style={styles.factRow}>
                <Ionicons name="alarm" size={16} color={colors.accent} />
                <Text style={[type.body, { flex: 1, marginLeft: spacing.sm }]}>
                  {new Date(v.at).toLocaleString([], {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </Text>
                <Pressable
                  hitSlop={8}
                  onPress={() => {
                    deleteVisitTime.mutate(v.id);
                    cancelVisitReminders(v.id).catch(() => {});
                  }}
                >
                  <Ionicons name="close-circle-outline" size={19} color={colors.textSecondary} />
                </Pressable>
              </View>
            ))}
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
              onEndEditing={() =>
                upsert.mutate(
                  { placeId: place.id, status: "visited", rating, note: note || null },
                  {
                    onSuccess: () => {
                      setNoteSaved(true);
                      setTimeout(() => setNoteSaved(false), 2000);
                    },
                  },
                )
              }
              multiline
            />
            {noteSaved && (
              <Text style={[type.caption, { color: colors.primary, marginTop: spacing.xs }]}>
                Saved ✓
              </Text>
            )}
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
