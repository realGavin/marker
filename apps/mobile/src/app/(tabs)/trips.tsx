import React, { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { TripTemplate } from "@marker/core";
import { skin } from "../../skin";
import { colors, spacing, type } from "../../ui/theme";
import {
  useMyLogs,
  usePlanTrip,
  useTemplatePlaces,
  useTripPlans,
  useUpsertLog,
  type TripItinerary,
} from "../../lib/data";

const BUDGETS = ["any", "$", "$$", "$$$"] as const;

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

export default function TripsScreen() {
  const router = useRouter();
  const { data: savedPlans } = useTripPlans();
  const planTrip = usePlanTrip();

  const [region, setRegion] = useState("");
  const [days, setDays] = useState("3");
  const [rounds, setRounds] = useState("3");
  const [budget, setBudget] = useState<(typeof BUDGETS)[number]>("any");
  const [notes, setNotes] = useState("");
  const [result, setResult] = useState<TripItinerary | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const generate = async () => {
    setErrorText(null);
    setResult(null);
    try {
      const res = await planTrip.mutateAsync({
        region,
        days: Number(days) || 3,
        rounds: Number(rounds) || 3,
        budget,
        notes: notes || undefined,
      });
      setResult(res.itinerary);
    } catch (e) {
      const code = (e as Error).message;
      if (code === "upgrade_required") {
        router.push("/paywall");
      } else if (code === "monthly_limit") {
        setErrorText("You've used this month's plans. Resets on the 1st.");
      } else if (code === "region_not_found" || code === "no_places_in_region") {
        setErrorText(`We couldn't find that area — try a city or state name.`);
      } else {
        setErrorText("Something went wrong building your trip. Try again.");
      }
    }
  };

  return (
    <>
      <ScrollView style={styles.container} contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xl * 2 }}>
        <Text style={type.title}>{skin.vocab.planTrip}</Text>
        <Text style={[type.caption, { marginTop: spacing.xs, marginBottom: spacing.md }]}>
          Real {skin.vocab.places} from our directory — never invented.
        </Text>

        <View style={styles.form}>
          <TextInput
            style={styles.input}
            placeholder="Where to? (city or state)"
            placeholderTextColor={colors.textSecondary}
            value={region}
            onChangeText={setRegion}
          />
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              placeholder="Days"
              placeholderTextColor={colors.textSecondary}
              keyboardType="number-pad"
              value={days}
              onChangeText={setDays}
            />
            <TextInput
              style={[styles.input, { flex: 1 }]}
              placeholder="Rounds"
              placeholderTextColor={colors.textSecondary}
              keyboardType="number-pad"
              value={rounds}
              onChangeText={setRounds}
            />
          </View>
          <View style={styles.budgetRow}>
            {BUDGETS.map((b) => (
              <Pressable
                key={b}
                style={[styles.budgetChip, budget === b && styles.budgetActive]}
                onPress={() => setBudget(b)}
              >
                <Text style={[styles.budgetText, budget === b && { color: "#FFF" }]}>
                  {b === "any" ? "Any budget" : b}
                </Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            style={[styles.input, { minHeight: 60 }]}
            placeholder="Anything else? (walkable, links style, resort…)"
            placeholderTextColor={colors.textSecondary}
            value={notes}
            onChangeText={setNotes}
            multiline
          />
          <Pressable
            style={[styles.generate, (planTrip.isPending || !region.trim()) && { opacity: 0.5 }]}
            onPress={generate}
            disabled={planTrip.isPending || !region.trim()}
          >
            {planTrip.isPending ? (
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

        {result && <Itinerary itinerary={result} title={region.trim() || undefined} />}

        <Text style={[type.heading, { marginTop: spacing.xl }]}>Trip ideas</Text>
        <Text style={[type.caption, { marginBottom: spacing.sm }]}>
          Editor-built trips, free for everyone.
        </Text>
        {skin.tripTemplates.map((t) => (
          <TemplateCard key={t.slug} template={t} />
        ))}

        {savedPlans && savedPlans.length > 0 && (
          <>
            <Text style={[type.heading, { marginTop: spacing.xl, marginBottom: spacing.sm }]}>
              Your saved trips
            </Text>
            {savedPlans.map((p) => (
              <SavedPlan key={p.id} title={p.request.region} itinerary={p.itinerary} />
            ))}
          </>
        )}
      </ScrollView>
    </>
  );
}

/** Day-by-day plain-text version of a plan for the native share sheet. */
function shareTrip(itinerary: TripItinerary, title?: string) {
  const lines: string[] = [];
  lines.push(title ? `${title} — ${skin.vocab.appName}` : skin.vocab.appName);
  if (itinerary.summary) lines.push(itinerary.summary);
  for (const d of itinerary.days) {
    lines.push("", `Day ${d.day}`);
    for (const p of d.places) {
      const where = [p.city, p.region].filter(Boolean).join(", ");
      lines.push(`• ${p.name}${where ? ` (${where})` : ""}`);
    }
    if (d.note) lines.push(d.note);
  }
  Share.share({ message: lines.join("\n") }).catch(() => {});
}

function Itinerary({ itinerary, title }: { itinerary: TripItinerary; title?: string }) {
  const router = useRouter();
  const { data: logs } = useMyLogs();
  const upsert = useUpsertLog();
  const [savedAll, setSavedAll] = useState(false);

  // itinerary stops carry slugs; resolve ids so the unlogged ones can be saved
  const stopSlugs = itinerary.days.flatMap((d) => d.places.map((p) => p.slug));
  const { data: stopPlaces } = useTemplatePlaces(stopSlugs);
  const loggedSlugs = new Set((logs ?? []).map((l) => l.place.slug));
  const unlogged = (stopPlaces ?? []).filter((p) => !loggedSlugs.has(p.slug));

  const saveAll = async () => {
    for (const p of unlogged) {
      await upsert.mutateAsync({ placeId: p.id, status: "want" }).catch(() => {});
    }
    setSavedAll(true);
  };

  return (
    <View style={styles.resultCard}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing.sm }}>
        <Text style={[type.body, { flex: 1 }]}>{itinerary.summary}</Text>
        <Pressable onPress={() => shareTrip(itinerary, title)} hitSlop={8}>
          <Ionicons name="share-outline" size={20} color={colors.primary} />
        </Pressable>
      </View>
      {itinerary.days.map((d) => (
        <View key={d.day} style={{ marginTop: spacing.md }}>
          <Text style={[type.caption, { fontWeight: "700", color: colors.primary }]}>DAY {d.day}</Text>
          {d.places.map((p) => (
            <Pressable
              key={p.id}
              style={styles.placeRow}
              onPress={() => router.push(`/place/${p.slug}`)}
            >
              <Ionicons name="flag" size={14} color={colors.accent} />
              <View style={{ flex: 1 }}>
                <Text style={type.body} numberOfLines={1}>{p.name}</Text>
                <Text style={type.caption}>{[p.city, p.region].filter(Boolean).join(", ")}</Text>
              </View>
              <Ionicons name="chevron-forward" size={14} color={colors.textSecondary} />
            </Pressable>
          ))}
          {d.note ? <Text style={[type.caption, { marginTop: 4 }]}>{d.note}</Text> : null}
        </View>
      ))}
      {(unlogged.length > 0 || savedAll) && (
        <Pressable
          style={[styles.saveAll, (savedAll || upsert.isPending) && { opacity: 0.7 }]}
          disabled={savedAll || upsert.isPending}
          onPress={saveAll}
        >
          <Ionicons name={savedAll ? "checkmark-circle" : "bookmark-outline"} size={16} color="#FFF" />
          <Text style={styles.saveAllText}>
            {savedAll
              ? "Saved — they're on your map now"
              : `Add all ${unlogged.length} to ${skin.vocab.wantTo.toLowerCase()}`}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

function SavedPlan({ title, itinerary }: { title: string; itinerary: TripItinerary }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.templateCard}>
      <Pressable style={{ flexDirection: "row", alignItems: "center" }} onPress={() => setOpen(!open)}>
        <View style={{ flex: 1 }}>
          <Text style={type.heading}>{title}</Text>
          <Text style={type.caption}>
            {itinerary.days.length} days · {itinerary.days.reduce((n, d) => n + d.places.length, 0)} stops
          </Text>
        </View>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={18} color={colors.textSecondary} />
      </Pressable>
      {open && <Itinerary itinerary={itinerary} title={title} />}
    </View>
  );
}

function TemplateCard({ template }: { template: TripTemplate }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { data: places } = useTemplatePlaces(template.placeSlugs);
  return (
    <View style={styles.templateCard}>
      <Pressable style={{ flexDirection: "row", alignItems: "center" }} onPress={() => setOpen(!open)}>
        <View style={{ flex: 1 }}>
          <Text style={type.heading}>{template.title}</Text>
          <Text style={type.caption}>{template.description}</Text>
        </View>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={18} color={colors.textSecondary} />
      </Pressable>
      {open &&
        (places ?? []).map((p) => (
          <Pressable
            key={p.id}
            style={styles.placeRow}
            onPress={() => router.push(`/place/${p.slug}`)}
          >
            <Ionicons name="flag" size={14} color={colors.accent} />
            <View style={{ flex: 1 }}>
              <Text style={type.body} numberOfLines={1}>{p.name}</Text>
              <Text style={type.caption}>{[p.city, p.region].filter(Boolean).join(", ")}</Text>
            </View>
            <Ionicons name="chevron-forward" size={14} color={colors.textSecondary} />
          </Pressable>
        ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  form: { gap: spacing.sm },
  input: {
    borderWidth: 1,
    borderColor: "#DDD8CC",
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    backgroundColor: colors.surface,
    color: colors.textPrimary,
    fontSize: 15,
  },
  budgetRow: { flexDirection: "row", gap: spacing.xs },
  budgetChip: {
    paddingHorizontal: spacing.md,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    borderColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  budgetActive: { backgroundColor: colors.primary },
  budgetText: { fontSize: 13, fontWeight: "600", color: colors.primary },
  generate: {
    height: 50,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
  },
  generateText: { color: "#FFF", fontSize: 16, fontWeight: "700" },
  resultCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  saveAll: {
    flexDirection: "row",
    gap: spacing.xs,
    height: 42,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.accent,
    marginTop: spacing.md,
  },
  saveAllText: { color: "#FFF", fontSize: 14, fontWeight: "700" },
  templateCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  placeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#EEE9DD",
  },
});
