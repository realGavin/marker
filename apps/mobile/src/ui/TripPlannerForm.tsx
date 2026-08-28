import React, { useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import DateTimePicker from "@react-native-community/datetimepicker";
import { skin } from "../skin";
import { colors, spacing, type } from "./theme";
import { dayDate, localDateString } from "../lib/dates";
import type { TripBrief } from "../lib/data";

/** Rotates while a plan is being built — same cadence as the old single-shot form. */
const LOADING_LINES = [
  "Reading the map…",
  "Pacing out your days…",
  "Weighing the drive times…",
  "Putting the route in order…",
];

function LoadingLine() {
  const [i, setI] = useState(0);
  React.useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % LOADING_LINES.length), 2500);
    return () => clearInterval(t);
  }, []);
  return <Text style={{ color: "#FFF", fontSize: 15, fontWeight: "600" }}>{LOADING_LINES[i]}</Text>;
}

/** Labeled +/- numeric control. */
function Stepper({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
}) {
  const set = (next: number) => onChange(Math.min(max, Math.max(min, next)));
  return (
    <View style={styles.stepper}>
      <Text style={type.caption}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Pressable style={styles.stepperButton} onPress={() => set(value - 1)} hitSlop={6}>
          <Ionicons name="remove" size={18} color={colors.primary} />
        </Pressable>
        <Text style={styles.stepperValue}>{value}</Text>
        <Pressable style={styles.stepperButton} onPress={() => set(value + 1)} hitSlop={6}>
          <Ionicons name="add" size={18} color={colors.primary} />
        </Pressable>
      </View>
    </View>
  );
}

function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <Pressable style={styles.toggleRow} onPress={() => onChange(!value)}>
      <Text style={[type.body, { flex: 1 }]}>{label}</Text>
      <Switch value={value} onValueChange={onChange} trackColor={{ false: "#DADAD6", true: colors.accentFill }} thumbColor="#FFF" />
    </Pressable>
  );
}

/** A single optional date row: tap to open an inline picker, tap the X to clear. */
function DateRow({ label, value, onChange }: { label: string; value: string | null; onChange: (v: string | null) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable style={styles.dateRow} onPress={() => setOpen((o) => !o)}>
        <Ionicons name="calendar-outline" size={16} color={colors.primary} />
        <Text style={[type.body, { flex: 1 }]}>{value ? `${label}: ${dayDate(value, 1)}` : label}</Text>
        {value && (
          <Pressable hitSlop={8} onPress={() => onChange(null)}>
            <Ionicons name="close-circle-outline" size={16} color={colors.textSecondary} />
          </Pressable>
        )}
      </Pressable>
      {open && (
        <DateTimePicker
          value={value ? new Date(value + "T12:00:00") : new Date()}
          mode="date"
          display="inline"
          onChange={(_e, d) => {
            if (d) onChange(localDateString(d));
            setOpen(false);
          }}
        />
      )}
    </View>
  );
}

// Labels say "apart", not "driving" or "under" a drive time — maxHopKm is a
// great-circle distance between stops (no routing data), which underestimates
// real road distance by 20-40%+ in hilly terrain. Same rule that keeps this
// app from showing a booking link or a travel-time estimate for features we
// have no data to back: don't state what we can't support.
const HOP_OPTIONS: Array<{ label: string; km: number | undefined }> = [
  { label: "Any distance", km: undefined },
  { label: "Stops within 50 km", km: 50 },
  { label: "Stops within 100 km", km: 100 },
  { label: "Stops within 200 km", km: 200 },
];

/**
 * The trip brief form: fast when it needs to be (three quick fields, then
 * go), guided when the user wants more control. Style chips are read
 * straight off the active skin's pinFilters/pinFilterGroups — this file
 * never hardcodes a tag's meaning, so a re-skin changes the whole
 * vocabulary for free.
 */
export function TripPlannerForm({
  initialRegion = "",
  initialDays = 3,
  pending,
  errorText,
  onSubmit,
}: {
  initialRegion?: string;
  initialDays?: number;
  pending: boolean;
  errorText: string | null;
  onSubmit: (brief: TripBrief) => void;
}) {
  const [region, setRegion] = useState(initialRegion);
  const [days, setDays] = useState(initialDays);
  // Distinct from `days`: a 5-day trip can carry 4 of these and a rest day.
  const [roundsCount, setRoundsCount] = useState(initialDays);
  const [startDate, setStartDate] = useState<string | null>(null);
  const [endDate, setEndDate] = useState<string | null>(null);
  const [maxHopKm, setMaxHopKm] = useState<number | undefined>(undefined);
  const [selectedStyles, setSelectedStyles] = useState<string[]>([]);
  const [includeWishlist, setIncludeWishlist] = useState(false);
  const [avoidPlayed, setAvoidPlayed] = useState(false);
  const [notes, setNotes] = useState("");
  const [expanded, setExpanded] = useState(false);
  // Belt-and-suspenders against a double-tap landing two submits before
  // `pending` (React state, not synchronous) has re-rendered the disabled
  // button — same guard as TripConversation's sendingRef, and for the same
  // reason: on the free tier a doubled submit spends two plans against an
  // allowance of one.
  const sendingRef = useRef(false);
  // `onSubmit` doesn't return a promise this form can await (the parent
  // fires an async mutation but hands back void), so the ref can only be
  // released once `pending` confirms the in-flight request is over.
  React.useEffect(() => {
    if (!pending) sendingRef.current = false;
  }, [pending]);

  const toggleStyle = (key: string) => {
    setSelectedStyles((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const submit = () => {
    if (sendingRef.current || pending || !region.trim()) return;
    sendingRef.current = true;
    onSubmit({
      region: region.trim(),
      startDate: startDate ?? undefined,
      endDate: endDate ?? undefined,
      days,
      rounds: roundsCount, // engine-purity-ignore: contract field name defined by the plan-trip function
      maxHopKm,
      styles: selectedStyles.length > 0 ? selectedStyles : undefined,
      includeWishlist: includeWishlist || undefined,
      avoidPlayed: avoidPlayed || undefined,
      notes: notes.trim() || undefined,
    });
  };

  return (
    <View style={styles.form}>
      <TextInput
        style={styles.input}
        placeholder="Where to? (city or state)"
        placeholderTextColor={colors.textSecondary}
        value={region}
        onChangeText={setRegion}
      />
      <View style={{ flexDirection: "row", gap: spacing.sm }}>
        <Stepper label="Days" value={days} onChange={setDays} min={1} max={14} />
        <Stepper label={skin.vocab.tripStops} value={roundsCount} onChange={setRoundsCount} min={1} max={days * 2} />
      </View>

      <Pressable style={styles.expandRow} onPress={() => setExpanded((e) => !e)}>
        <Text style={styles.expandText}>{expanded ? "Fewer options" : "More options"}</Text>
        <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={16} color={colors.primary} />
      </Pressable>

      {expanded && (
        <View style={{ gap: spacing.sm }}>
          <DateRow label="Start date" value={startDate} onChange={setStartDate} />
          <DateRow label="End date" value={endDate} onChange={setEndDate} />

          <Text style={type.caption}>Straight-line distance between stops</Text>
          <View style={styles.chipWrap}>
            {HOP_OPTIONS.map((opt) => {
              const active = maxHopKm === opt.km;
              return (
                <Pressable
                  key={opt.label}
                  style={[styles.optionChip, active && styles.optionChipActive]}
                  onPress={() => setMaxHopKm(opt.km)}
                >
                  <Text style={[styles.optionChipText, active && { color: "#FFF" }]}>{opt.label}</Text>
                </Pressable>
              );
            })}
          </View>

          {/*
            Styles come from skin.tripStyles, NOT skin.pinFilters. They are
            different vocabularies on purpose: a map filter has to divide the
            catalogue usefully, a planning preference can be an exclusion most
            places satisfy. "Walkable" only exists in the trip list for exactly
            that reason. Sourcing these from pinFilters is what previously made
            a preference the server accepts unreachable from the app.
          */}
          <Text style={[type.label, { marginBottom: 4 }]}>Style</Text>
          <View style={styles.chipWrap}>
            {skin.tripStyles.map((s2) => {
              const active = selectedStyles.includes(s2.key);
              return (
                <Pressable
                  key={s2.key}
                  style={[styles.optionChip, active && styles.optionChipActive]}
                  onPress={() => toggleStyle(s2.key)}
                >
                  <Text style={[styles.optionChipText, active && { color: "#FFF" }]}>{s2.label}</Text>
                </Pressable>
              );
            })}
          </View>

          <ToggleRow
            label={`Include places from my ${skin.vocab.wantTo.toLowerCase()} list`}
            value={includeWishlist}
            onChange={setIncludeWishlist}
          />
          <ToggleRow
            label={`Skip ${skin.vocab.places} I've already ${skin.vocab.visited.toLowerCase()}`}
            value={avoidPlayed}
            onChange={setAvoidPlayed}
          />

          <TextInput
            style={[styles.input, { minHeight: 60 }]}
            placeholder={skin.vocab.tripNotesHint}
            placeholderTextColor={colors.textSecondary}
            value={notes}
            onChangeText={setNotes}
            multiline
          />
        </View>
      )}

      <Pressable
        style={[styles.generate, (pending || !region.trim()) && { opacity: 0.5 }]}
        onPress={submit}
        disabled={pending || !region.trim()}
      >
        {pending ? (
          <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
            <ActivityIndicator color="#FFF" />
            <LoadingLine />
          </View>
        ) : (
          <Text style={styles.generateText}>Build my trip</Text>
        )}
      </Pressable>
      {errorText ? <Text style={[type.caption, { color: "#B4552D" }]}>{errorText}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.sm },
  input: {
    borderWidth: 1,
    borderColor: "#DADAD6",
    borderRadius: 3,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    backgroundColor: colors.surface,
    color: colors.textPrimary,
    fontSize: 15,
  },
  stepper: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#DADAD6",
    borderRadius: 3,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    backgroundColor: colors.surface,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  stepperButton: {
    width: 28,
    height: 28,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#EDEDEA",
  },
  stepperValue: { fontSize: 16, fontWeight: "700", color: colors.textPrimary, minWidth: 20, textAlign: "center" },
  expandRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingVertical: spacing.xs,
  },
  expandText: { fontSize: 13, fontWeight: "700", color: colors.primary },
  dateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: "#DADAD6",
    borderRadius: 3,
    backgroundColor: colors.surface,
  },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginBottom: spacing.xs },
  optionChip: {
    paddingHorizontal: spacing.sm,
    height: 30,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  optionChipActive: { backgroundColor: colors.primary },
  optionChipText: { fontSize: 12, fontWeight: "600", color: colors.primary },
  toggleRow: { flexDirection: "row", alignItems: "center", paddingVertical: spacing.xs },
  generate: {
    height: 50,
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
    marginTop: spacing.xs,
  },
  generateText: { color: "#FFF", fontSize: 16, fontWeight: "700" },
});
