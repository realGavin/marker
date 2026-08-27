import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, radii, spacing, type } from "./theme";
import type { ConditionScore } from "../lib/data";

const SCORE_OPTIONS: Array<{ value: ConditionScore; label: string }> = [
  { value: "good", label: "Good" },
  { value: "ok", label: "OK" },
  { value: "poor", label: "Poor" },
];

/**
 * Verdict colors, shared by every surface that shows a scored condition.
 * Poor reuses the app's one established warning tone; OK reads off the
 * skin's accent (already the "signal" color in Machined Light); Good is a
 * separate, muted positive — deliberately not the map's visited-pin green,
 * which stays reserved for visited-status pin data, never chrome.
 */
const SCORE_COLOR: Record<ConditionScore, string> = {
  good: "#3F6B52",
  ok: colors.accent,
  poor: "#B4552D",
};

export function scoreColor(score: ConditionScore): string {
  return SCORE_COLOR[score];
}

export function scoreLabel(score: ConditionScore): string {
  return SCORE_OPTIONS.find((o) => o.value === score)?.label ?? score;
}

/**
 * One aspect's verdict row: a label plus a Good / OK / Poor segmented
 * control. `value` is undefined when the user hasn't touched this aspect —
 * tapping the active option again clears it back to untouched, so a whole
 * sheet of these rows only ever submits the aspects someone actually picked.
 */
export function ScoreRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ConditionScore | undefined;
  onChange: (next: ConditionScore | undefined) => void;
}) {
  return (
    <View style={styles.row}>
      <Text style={[type.body, styles.label]} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.segments}>
        {SCORE_OPTIONS.map((opt) => {
          const active = value === opt.value;
          const tint = scoreColor(opt.value);
          return (
            <Pressable
              key={opt.value}
              hitSlop={4}
              style={[styles.segment, active && { backgroundColor: tint, borderColor: tint }]}
              onPress={() => onChange(active ? undefined : opt.value)}
            >
              <Text style={[styles.segmentText, active && { color: "#FFF" }]}>{opt.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: 6 },
  label: { flex: 1 },
  segments: { flexDirection: "row", gap: 6 },
  segment: {
    borderWidth: 1,
    borderColor: colors.hairline,
    borderRadius: radii.chip,
    paddingVertical: 5,
    paddingHorizontal: 9,
  },
  segmentText: { fontSize: 12, fontWeight: "600", color: colors.textPrimary },
});
