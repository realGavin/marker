import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
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
import { colors, spacing, type, radii } from "../../ui/theme";
import { ScoreRow, scoreColor, scoreLabel } from "../../ui/ConditionScore";
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
  usePlaceRating,
  useConditions,
  useReportCondition,
  useEndorseCondition,
  useReportContent,
  type ConditionSummary,
  type ConditionScore,
} from "../../lib/data";
import { useRouter } from "expo-router";
import DateTimePicker from "@react-native-community/datetimepicker";
import { PlacePhoto } from "../../ui/PlacePhoto";
import { PostVisitSheet, StarRating } from "../../ui/PostVisitSheet";
import { scheduleVisitReminders, cancelVisitReminders } from "../../lib/reminders";
import { useVisitTimes, useAddVisitTime, useDeleteVisitTime } from "../../lib/data";
import { pins } from "../../lib/pins";

/** Rating stored as 0–20 (half steps); shown as 0–10. */
const shownRating = (r: number) => (r / 2).toFixed(r % 2 ? 1 : 0);

/** e.g. "4 days ago"; falls back gracefully for very fresh reports. */
function relativeAge(iso: string): string {
  const mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return mins <= 1 ? "just now" : `${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** Always render condition labels from the skin — the engine never names one. */
function conditionLabel(kind: string): string {
  return skin.conditionKinds.find((k) => k.key === kind)?.label ?? kind;
}

type Fact = ReturnType<typeof skin.attributeFacts>[number];
/** A fact the skin marked for the instrument strip by giving it a `cluster`. */
type ClusterFact = Fact & { cluster: NonNullable<Fact["cluster"]> };

/** The strip fits four instruments; the skin picks which, and in what order. */
const CLUSTER_MAX = 4;

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
  const [postVisitOpen, setPostVisitOpen] = useState(false);

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
  const clusterFacts = facts
    .filter((f): f is ClusterFact => f.cluster !== undefined)
    .slice(0, CLUSTER_MAX);
  const rowFacts = facts.filter((f) => f.cluster === undefined);
  const settingChips = skin.settingChips?.(place.attrs) ?? [];
  // Anything the skin flagged as computed from open data — including the chips.
  const showDataFootnote = facts.some((f) => f.derived) || settingChips.length > 0;
  const website = (place.attrs as { website?: string } | null)?.website;
  const location = [place.city, place.region].filter(Boolean).join(", ");
  // Coordinates come from the bundled pin directory (same offline dataset
  // that drives the map), since the place API doesn't expose lat/lng today.
  const pin = pins.find((p) => p.slug === place.slug);
  const quickActions = skin.externalLinks
    .map((link) => ({
      key: link.key,
      label: link.label,
      icon: link.icon,
      href: link.url({
        name: place.name,
        city: place.city,
        region: place.region,
        lat: pin?.lat ?? 0,
        lng: pin?.lng ?? 0,
        website: website ?? null,
      }),
    }))
    .filter((link): link is typeof link & { href: string } => link.href !== null);
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
      return;
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    upsert.mutate(
      { placeId: place.id, status: next, rating, note: note || null },
      {
        onSuccess: () => {
          if (next === "visited" && rating == null) setPostVisitOpen(true);
        },
      },
    );
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

        {quickActions.length > 0 && (
          <View style={styles.quickActionsRow}>
            {quickActions.map((action, i, arr) => (
              <Pressable
                key={action.key}
                style={[styles.quickAction, i < arr.length - 1 && styles.quickActionDivider]}
                onPress={() => Linking.openURL(action.href).catch(() => {})}
              >
                <Ionicons name={action.icon as never} size={21} color={colors.primary} />
                <Text style={type.label} numberOfLines={1}>
                  {action.label}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        {settingChips.length > 0 && (
          <View style={styles.chipRow}>
            {settingChips.map((chip) => (
              <View key={chip} style={styles.chip}>
                <Text style={[type.label, { color: colors.textPrimary }]}>{chip}</Text>
              </View>
            ))}
          </View>
        )}

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
            {/* Same half-tap StarRating the post-visit sheet uses (see M2) —
                one rating control app-wide, not a 10-star row here and a
                5-star row there rendering the identical stored value two
                different ways. */}
            <StarRating value={rating} onChange={saveDetails} />
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
            {/* instrument strip: whichever facts the skin gave a cluster payload */}
            {clusterFacts.length > 0 && (
              <View style={styles.instrumentRow}>
                {clusterFacts.map((f, i, arr) => (
                  <View
                    key={f.label}
                    style={[styles.instrument, i < arr.length - 1 && styles.instrumentDivider]}
                  >
                    <Text style={type.numeral}>{f.cluster.numeral}</Text>
                    <Text style={type.label}>{f.cluster.unit}</Text>
                  </View>
                ))}
              </View>
            )}
            {rowFacts.map((f) => (
              <View key={f.label} style={styles.factRow}>
                <Text style={[type.label, { width: 100 }]}>{f.label}</Text>
                <Text style={type.body}>{f.value}</Text>
              </View>
            ))}
            {showDataFootnote && (
              <Text style={[type.caption, { fontSize: 10, marginTop: spacing.sm }]}>
                Some facts are derived from open map and climate data.
              </Text>
            )}
          </View>
        )}

        <CommunityPulse placeId={place.id} />

        <View style={styles.card}>
          <Text style={type.body}>{place.description ?? "Description coming soon."}</Text>
        </View>

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
      <PostVisitSheet
        visible={postVisitOpen}
        placeId={place.id}
        note={note}
        onClose={() => setPostVisitOpen(false)}
      />
    </>
  );
}

/**
 * Community rating + condition advisories, right after the instrument
 * cluster. Every piece hides on its own when there's no data — this whole
 * block can render as just the always-on "Report condition" row.
 */
function CommunityPulse({ placeId }: { placeId: string }) {
  const { data: rating } = usePlaceRating(placeId);
  const { data: conditions } = useConditions(placeId);
  const [openCondition, setOpenCondition] = useState<ConditionSummary | null>(null);
  const [reportOpen, setReportOpen] = useState(false);

  return (
    <View style={styles.card}>
      {rating && (
        <View style={styles.pulseRating}>
          <Text style={type.numeral}>{(rating.avg / 2).toFixed(1)}</Text>
          <Text style={type.label}>{rating.rating_count} ratings</Text>
        </View>
      )}
      {conditions && conditions.length > 0 && (
        <View style={styles.chipRow}>
          {conditions.map((c) => (
            <Pressable
              key={c.kind}
              style={[styles.conditionChip, { borderColor: scoreColor(c.score) }]}
              onPress={() => setOpenCondition(c)}
            >
              <Text style={[type.label, { color: scoreColor(c.score) }]}>
                {conditionLabel(c.kind)} — {scoreLabel(c.score)} · {c.reporters}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      <Pressable style={styles.addToList} onPress={() => setReportOpen(true)}>
        <Ionicons name="megaphone-outline" size={17} color={colors.primary} />
        <Text style={styles.addToListText}>Report condition</Text>
      </Pressable>

      <ConditionDetailSheet condition={openCondition} placeId={placeId} onClose={() => setOpenCondition(null)} />
      <ReportConditionSheet visible={reportOpen} placeId={placeId} onClose={() => setReportOpen(false)} />
    </View>
  );
}

function ConditionDetailSheet({
  condition,
  placeId,
  onClose,
}: {
  condition: ConditionSummary | null;
  placeId: string;
  onClose: () => void;
}) {
  const endorse = useEndorseCondition();
  const reportContent = useReportContent();
  // "done" renews the report's freshness — it does not raise the reporter
  // count, which only grows from independent report_condition calls.
  // "own" is a real, expected state (your own report put the row here), not
  // an error — the endorse RPC rejects it with own_report.
  const [endorseState, setEndorseState] = useState<"idle" | "done" | "own">("idle");

  useEffect(() => setEndorseState("idle"), [condition?.kind]);

  if (!condition) return null;

  const doEndorse = () => {
    Haptics.selectionAsync().catch(() => {});
    endorse.mutate(
      { placeId, reportId: condition.latest_report_id },
      {
        onSuccess: () => setEndorseState("done"),
        onError: (err) => {
          if ((err as Error).message?.includes("own_report")) setEndorseState("own");
          // any other failure: stay idle, so a retap just tries again
        },
      },
    );
  };

  const doReport = () => {
    Alert.alert("Report this condition note?", "We review reports within 24 hours.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Report",
        style: "destructive",
        onPress: () =>
          reportContent.mutate({
            targetType: "condition_report",
            targetId: condition.latest_report_id,
            reason: "inappropriate condition report",
          }),
      },
    ]);
  };

  const endorseLabel =
    endorseState === "done" ? "Still there — thanks" : endorseState === "own" ? "That's your report" : "I saw this too";

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <Text style={type.heading}>{conditionLabel(condition.kind)}</Text>
        <Text style={[type.body, { color: scoreColor(condition.score), fontWeight: "700", marginTop: spacing.xs }]}>
          {scoreLabel(condition.score)} · {condition.reporters} reports · {relativeAge(condition.latest_at)}
        </Text>
        {condition.latest_note ? (
          <Text style={[type.body, { marginTop: spacing.sm }]}>{condition.latest_note}</Text>
        ) : null}
        <Pressable
          style={[styles.button, (endorseState !== "idle" || endorse.isPending) && { opacity: 0.6 }]}
          disabled={endorseState !== "idle" || endorse.isPending}
          onPress={doEndorse}
        >
          <Text style={styles.buttonText}>{endorseLabel}</Text>
        </Pressable>
        <Pressable style={{ marginTop: spacing.md, alignSelf: "center" }} onPress={doReport} hitSlop={8}>
          <Text style={[type.caption, { color: "#B4552D" }]}>Report</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

/** Pick one aspect, score it Good/OK/Poor, optionally note it — one report, done. */
function ReportConditionSheet({
  visible,
  placeId,
  onClose,
}: {
  visible: boolean;
  placeId: string;
  onClose: () => void;
}) {
  const reportCondition = useReportCondition();
  const [kind, setKind] = useState<string | null>(null);
  const [score, setScore] = useState<ConditionScore | undefined>(undefined);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (visible) {
      setKind(null);
      setScore(undefined);
      setNote("");
    }
  }, [visible]);

  if (!visible) return null;

  const selectedFact = skin.conditionKinds.find((k) => k.key === kind);

  const submit = async () => {
    if (!kind || !score) return;
    try {
      await reportCondition.mutateAsync({ placeId, kind, score, note: note.trim() || null });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      onClose();
    } catch {
      Alert.alert("Couldn't save", "Please try again.");
    }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <Text style={type.heading}>Report condition</Text>
        <View style={[styles.chipRow, { marginTop: spacing.sm }]}>
          {skin.conditionKinds.map((k) => (
            <Pressable
              key={k.key}
              style={[styles.chip, kind === k.key && styles.chipActive]}
              onPress={() => setKind(kind === k.key ? null : k.key)}
            >
              <Text style={[type.label, { color: kind === k.key ? "#FFF" : colors.textPrimary }]}>{k.label}</Text>
            </Pressable>
          ))}
        </View>
        {selectedFact && (
          <View style={{ marginTop: spacing.sm }}>
            <ScoreRow label={selectedFact.label} value={score} onChange={setScore} />
          </View>
        )}
        <TextInput
          style={[styles.noteInput, { marginTop: spacing.sm }]}
          placeholder="Add a note (optional)"
          placeholderTextColor={colors.textSecondary}
          value={note}
          onChangeText={(v) => setNote(v.slice(0, 200))}
          maxLength={200}
          multiline
        />
        <Pressable
          style={[styles.button, (!kind || !score || reportCondition.isPending) && { opacity: 0.6 }]}
          disabled={!kind || !score || reportCondition.isPending}
          onPress={submit}
        >
          <Text style={styles.buttonText}>{reportCondition.isPending ? "Saving…" : "Submit"}</Text>
        </Pressable>
      </View>
    </Modal>
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
    borderRadius: 3,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
    borderColor: colors.primary,
    backgroundColor: colors.surface,
  },
  statusActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  statusActiveWant: { backgroundColor: colors.accentFill, borderColor: colors.accent },
  statusText: { fontSize: 15, fontWeight: "600", color: colors.primary },
  quickActionsRow: {
    flexDirection: "row",
    marginTop: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radii.card,
    borderWidth: 1,
    borderColor: colors.hairline,
  },
  quickAction: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: spacing.sm,
  },
  quickActionDivider: { borderRightWidth: 1, borderRightColor: colors.hairline },
  ratingRow: { flexDirection: "row", gap: 4, marginVertical: spacing.sm },
  noteInput: {
    marginTop: spacing.sm,
    minHeight: 60,
    borderWidth: 1,
    borderColor: "#DADAD6",
    borderRadius: 3,
    padding: spacing.sm,
    color: colors.textPrimary,
    backgroundColor: colors.background,
  },
  card: { backgroundColor: colors.surface, borderRadius: 4, padding: spacing.md, marginTop: spacing.md },
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
    borderTopColor: "#E7E7E3",
    marginTop: spacing.xs,
  },
  factRow: { flexDirection: "row", alignItems: "center", paddingVertical: spacing.xs },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: spacing.sm,
  },
  chip: {
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radii.chip,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  instrumentRow: {
    flexDirection: "row",
    paddingVertical: spacing.xs,
    marginBottom: spacing.xs,
  },
  instrument: { flex: 1, alignItems: "center", gap: 3 },
  instrumentDivider: { borderRightWidth: 1, borderRightColor: colors.hairline },
  button: {
    marginTop: spacing.md,
    height: 48,
    borderRadius: 3,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
  },
  buttonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
  pulseRating: { alignItems: "center", gap: 3, paddingBottom: spacing.sm },
  conditionChip: {
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radii.chip,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  sheetBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
  },
});
