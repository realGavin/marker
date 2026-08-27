import React, { useEffect, useState } from "react";
import {
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import * as Haptics from "expo-haptics";
import { skin } from "../skin";
import { colors, radii, spacing, type } from "./theme";
import { ScoreRow } from "./ConditionScore";
import { useMyLogs, useReportCondition, useUpsertLog, type ConditionScore } from "../lib/data";

const STAR_SIZE = 32;
const STAR_HALF = STAR_SIZE / 2;
/** 5 glyphs standing in for the same 10 discrete values the old 10-star row offered. */
const STAR_COUNT = 5;

const capitalize = (s: string) => (s.length ? s[0]!.toUpperCase() + s.slice(1) : s);

/**
 * 5 stars, half-step taps. Backs the SAME 0-20 half-step storage scale the
 * rest of the app reads (place_logs.rating) — this only changes the tap
 * target, not the value space. Star `i` (1-5) spans storage values
 * (i-1)*4+2 (its left/half tap) through i*4 (its right/full tap), so the
 * five stars together still resolve to exactly {2,4,6,...,20}, the same ten
 * values the old ten-star row exposed.
 *
 * Hit-testing is NOT done by reading tap coordinates off the glyph — the
 * Ionicons glyph renders its own touchable text node smaller than the
 * Pressable around it, so `locationX` resolves against whichever frame the
 * tap landed in and the effective "half" boundary drifted well off 50%.
 * Instead each star is two absolutely-positioned, exactly-16pt-wide
 * Pressables (left = half value, right = full value) stacked over a single
 * `pointerEvents="none"` glyph that only ever renders, never receives
 * touches. The boundary between left/right is therefore always exactly
 * STAR_HALF, regardless of icon metrics or padding.
 *
 * hitSlop only grows the top/bottom of each half-star hit zone, never
 * left/right — a horizontal hitSlop would eat into the 4pt `gap` between
 * stars from both sides at once, so two neighboring Pressables would both
 * claim taps landing in that gap.
 */
export function StarRating({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (next: number | null) => void;
}) {
  return (
    <View style={styles.ratingRow}>
      {Array.from({ length: STAR_COUNT }, (_, i) => i + 1).map((star) => {
        const fullValue = star * 4;
        const halfValue = star * 4 - 2;
        const filled = value != null && value >= fullValue;
        const halfFilled = !filled && value != null && value >= halfValue;
        const iconName = filled ? "star" : halfFilled ? "star-half" : "star-outline";
        return (
          <View key={star} style={styles.starWrap}>
            <Ionicons name={iconName} size={26} color={colors.accent} pointerEvents="none" />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${star - 0.5} out of 10`}
              hitSlop={{ top: 6, bottom: 6, left: 0, right: 0 }}
              style={[styles.starHitZone, { left: 0 }]}
              onPress={() => onChange(value === halfValue ? null : halfValue)}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${star} out of 5`}
              hitSlop={{ top: 6, bottom: 6, left: 0, right: 0 }}
              style={[styles.starHitZone, { left: STAR_HALF }]}
              onPress={() => onChange(value === fullValue ? null : fullValue)}
            />
          </View>
        );
      })}
    </View>
  );
}

/**
 * One-tap capture shown right after a place is marked visited, if it has no
 * rating yet. Dismissable without saving anything — the visited log write
 * already happened before this ever opens.
 *
 * `note` should be the place's existing note (or null if none), so this
 * sheet's rating-only save doesn't blank it out — useUpsertLog does a
 * full-row upsert, so whatever we send here replaces the stored note. If a
 * caller omits the prop, we defensively fall back to whatever's already on
 * record via useMyLogs() instead of writing null, so a forgetful call site
 * can never silently wipe a user's note.
 */
export function PostVisitSheet({
  visible,
  placeId,
  note,
  onClose,
}: {
  visible: boolean;
  placeId: string;
  note?: string | null;
  onClose: () => void;
}) {
  const upsertLog = useUpsertLog();
  const reportCondition = useReportCondition();
  const { data: myLogs } = useMyLogs();
  const existingNote = myLogs?.find((l) => l.place_id === placeId)?.note ?? null;
  const noteToSave = note !== undefined ? note : existingNote;
  const { height: windowHeight } = useWindowDimensions();
  const [rating, setRating] = useState<number | null>(null);
  const [scores, setScores] = useState<Record<string, ConditionScore | undefined>>({});
  const [conditionNote, setConditionNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [keyboardVisible, setKeyboardVisible] = useState(false);

  useEffect(() => {
    if (visible) {
      setRating(null);
      setScores({});
      setConditionNote("");
    }
  }, [visible]);

  useEffect(() => {
    const willShow = Keyboard.addListener("keyboardWillShow", () => setKeyboardVisible(true));
    const didShow = Keyboard.addListener("keyboardDidShow", () => setKeyboardVisible(true));
    const willHide = Keyboard.addListener("keyboardWillHide", () => setKeyboardVisible(false));
    const didHide = Keyboard.addListener("keyboardDidHide", () => setKeyboardVisible(false));
    return () => {
      willShow.remove();
      didShow.remove();
      willHide.remove();
      didHide.remove();
    };
  }, []);

  if (!visible) return null;

  const setScore = (kind: string, next: ConditionScore | undefined) =>
    setScores((prev) => ({ ...prev, [kind]: next }));

  const touchedEntries = Object.entries(scores).filter(
    (entry): entry is [string, ConditionScore] => entry[1] !== undefined,
  );
  // A shared note field can only honestly attach to ONE aspect's public
  // report — sending the same text to every scored aspect lets one note
  // (e.g. "bunkers haven't been raked") get attributed to an unrelated,
  // contradicting aspect (the note would show under "Greens · 4 good"). So it
  // only ever rides along when exactly one aspect was scored.
  const singleAspectKind = touchedEntries.length === 1 ? touchedEntries[0][0] : null;
  const singleAspectLabel = singleAspectKind
    ? (skin.conditionKinds.find((k) => k.key === singleAspectKind)?.label ?? singleAspectKind)
    : null;

  const save = async () => {
    setSaving(true);
    try {
      await upsertLog.mutateAsync({ placeId, status: "visited", rating, note: noteToSave });
    } catch {
      setSaving(false);
      Alert.alert("Couldn't save", "Please try again.");
      return;
    }

    // The visit + rating are saved as of here, regardless of what happens
    // below — condition reports are a separate, independently-idempotent
    // write (see useReportCondition), so a partial failure past this point
    // must never be described as nothing having saved.
    let failedLabels: string[] = [];
    if (touchedEntries.length > 0) {
      // Concurrent, not sequential — N aspects shouldn't cost N round trips
      // of latency. allSettled (not all) so one rejection can't hide the
      // others' outcomes from the message below.
      const results = await Promise.allSettled(
        touchedEntries.map(([kind, score]) =>
          reportCondition.mutateAsync({
            placeId,
            kind,
            score,
            note: touchedEntries.length === 1 ? conditionNote.trim() || null : null,
          }),
        ),
      );
      failedLabels = results
        .map((r, i) => (r.status === "rejected" ? touchedEntries[i][0] : null))
        .filter((k): k is string => k !== null)
        .map((k) => skin.conditionKinds.find((c) => c.key === k)?.label ?? k);
    }

    setSaving(false);
    Haptics.notificationAsync(
      failedLabels.length > 0
        ? Haptics.NotificationFeedbackType.Warning
        : Haptics.NotificationFeedbackType.Success,
    ).catch(() => {});
    onClose();
    if (failedLabels.length > 0) {
      Alert.alert(
        "Rating saved",
        `Everything saved except: ${failedLabels.join(", ")}. You can report ${
          failedLabels.length === 1 ? "it" : "them"
        } again from the place page.`,
      );
    }
  };

  const dismiss = () => (keyboardVisible ? Keyboard.dismiss() : onClose());

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.flexFill} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <Pressable style={styles.backdrop} onPress={dismiss} />
        <View style={[styles.sheet, { maxHeight: windowHeight * 0.85 }]}>
          <View style={styles.header}>
            <Text style={type.heading}>How was it?</Text>
            <Pressable hitSlop={8} onPress={onClose}>
              <Ionicons name="close" size={20} color={colors.textSecondary} />
            </Pressable>
          </View>

          <ScrollView
            style={styles.body}
            contentContainerStyle={styles.bodyContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <StarRating value={rating} onChange={setRating} />
            {rating != null && <Text style={type.caption}>{(rating / 2).toFixed(rating % 2 ? 1 : 0)} / 10</Text>}

            <Text style={[type.label, { marginTop: spacing.md }]}>
              {capitalize(skin.vocab.place)} conditions (optional)
            </Text>
            <View style={{ marginTop: spacing.xs }}>
              {skin.conditionKinds.map((k) => (
                <ScoreRow key={k.key} label={k.label} value={scores[k.key]} onChange={(next) => setScore(k.key, next)} />
              ))}
            </View>
            <TextInput
              style={styles.noteInput}
              placeholder={singleAspectLabel ? `Note about ${singleAspectLabel} (optional)` : "Add a note (optional)"}
              placeholderTextColor={colors.textSecondary}
              value={conditionNote}
              onChangeText={(v) => setConditionNote(v.slice(0, 200))}
              maxLength={200}
              multiline
            />
            {touchedEntries.length > 1 && (
              <Text style={[type.caption, { marginTop: spacing.xs }]}>
                Note only saves when a single condition is scored — score just one aspect to attach it.
              </Text>
            )}
          </ScrollView>

          <Pressable
            style={[styles.button, (rating == null || saving) && { opacity: 0.6 }]}
            disabled={rating == null || saving}
            onPress={save}
          >
            <Text style={styles.buttonText}>{saving ? "Saving…" : "Save"}</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flexFill: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
  },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  body: { flexGrow: 0, flexShrink: 1 },
  bodyContent: { paddingBottom: spacing.sm },
  ratingRow: { flexDirection: "row", gap: 4, marginTop: spacing.md },
  starWrap: { width: STAR_SIZE, height: STAR_SIZE, alignItems: "center", justifyContent: "center" },
  starHitZone: { position: "absolute", top: 0, width: STAR_HALF, height: STAR_SIZE },
  noteInput: {
    marginTop: spacing.sm,
    minHeight: 56,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: 3,
    padding: spacing.sm,
    color: colors.textPrimary,
    backgroundColor: colors.background,
  },
  button: {
    marginTop: spacing.lg,
    height: 48,
    borderRadius: radii.control,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
  },
  buttonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
});
