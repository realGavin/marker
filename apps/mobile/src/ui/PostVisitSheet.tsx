import React, { useEffect, useState } from "react";
import { Alert, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import * as Haptics from "expo-haptics";
import { skin } from "../skin";
import { colors, radii, spacing, type } from "./theme";
import { useReportCondition, useUpsertLog } from "../lib/data";

const STARS = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20];

/**
 * One-tap capture shown right after a place is marked visited, if it has no
 * rating yet. Dismissable without saving anything — the visited log write
 * already happened before this ever opens.
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
  const [rating, setRating] = useState<number | null>(null);
  const [flags, setFlags] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible) {
      setRating(null);
      setFlags(new Set());
    }
  }, [visible]);

  if (!visible) return null;

  const toggleFlag = (key: string) => {
    setFlags((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      await upsertLog.mutateAsync({ placeId, status: "visited", rating, note: note ?? null });
      for (const kind of flags) {
        await reportCondition.mutateAsync({ placeId, kind, note: null }).catch(() => {});
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      onClose();
    } catch {
      Alert.alert("Couldn't save", "Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={styles.sheet}>
        <View style={styles.header}>
          <Text style={type.heading}>How was it?</Text>
          <Pressable hitSlop={8} onPress={onClose}>
            <Ionicons name="close" size={20} color={colors.textSecondary} />
          </Pressable>
        </View>

        <View style={styles.ratingRow}>
          {STARS.map((r) => (
            <Pressable key={r} onPress={() => setRating(rating === r ? null : r)} hitSlop={4}>
              <Ionicons
                name={rating != null && rating >= r ? "star" : "star-outline"}
                size={26}
                color={colors.accent}
              />
            </Pressable>
          ))}
        </View>
        {rating != null && <Text style={type.caption}>{(rating / 2).toFixed(rating % 2 ? 1 : 0)} / 10</Text>}

        <Text style={[type.label, { marginTop: spacing.md }]}>Anything worth flagging?</Text>
        <View style={styles.chipRow}>
          {skin.conditionKinds.map((k) => (
            <Pressable
              key={k.key}
              style={[styles.chip, flags.has(k.key) && styles.chipActive]}
              onPress={() => toggleFlag(k.key)}
            >
              <Text style={[type.label, { color: flags.has(k.key) ? "#FFF" : colors.textPrimary }]}>{k.label}</Text>
            </Pressable>
          ))}
        </View>

        <Pressable
          style={[styles.button, (rating == null || saving) && { opacity: 0.6 }]}
          disabled={rating == null || saving}
          onPress={save}
        >
          <Text style={styles.buttonText}>{saving ? "Saving…" : "Save"}</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.sheet,
    borderTopRightRadius: radii.sheet,
    padding: spacing.lg,
    paddingBottom: spacing.xl,
  },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  ratingRow: { flexDirection: "row", gap: 4, marginTop: spacing.md },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: spacing.sm },
  chip: {
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radii.chip,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
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
