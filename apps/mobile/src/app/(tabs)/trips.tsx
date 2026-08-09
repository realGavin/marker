import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
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
import DateTimePicker from "@react-native-community/datetimepicker";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Haptics from "expo-haptics";
import type { TripTemplate } from "@marker/core";
import { skin } from "../../skin";
import { colors, radii, spacing, type } from "../../ui/theme";
import { searchPins } from "../../lib/pins";
import { useAuth } from "../../providers/auth";
import {
  fetchPlaceBySlug,
  useAdoptTrip,
  useBlockUser,
  useCreateTrip,
  useDeleteTrip,
  useDeleteVisitTime,
  useJoinTrip,
  useMyLogs,
  usePlanTrip,
  usePublishedTrips,
  usePublishTrip,
  useReportContent,
  useTemplatePlaces,
  useTripPlans,
  useUnpublishTrip,
  useUnvoteTrip,
  useUpdateTrip,
  useUpsertLog,
  useVisitTimes,
  useVoteTrip,
  type PublishedTrip,
  type TripItinerary,
  type TripPlan,
} from "../../lib/data";
import { cancelVisitReminders, reconcileReminders } from "../../lib/reminders";
import { PostVisitSheet } from "../../ui/PostVisitSheet";

const COMMUNITY_TERMS_KEY = "marker.communityTermsAcceptedAt";
const POST_VISIT_PROMPTED_KEY = "marker.postVisitPrompted";

/** Visit-time ids the user has already been prompted about (once-only, see persistPromptedIds). */
async function getPromptedVisitIds(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(POST_VISIT_PROMPTED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

// Serializes writes to POST_VISIT_PROMPTED_KEY behind a single in-flight
// promise chain, so two dismissals in quick succession can never race and
// clobber each other. Each write always carries the full set already
// merged in local component state (see dismissPrompt) rather than doing a
// read-modify-write against storage, which is what let one of two rapid
// dismissals get lost before.
let promptedWriteChain: Promise<void> = Promise.resolve();
function persistPromptedIds(ids: Set<string>): Promise<void> {
  promptedWriteChain = promptedWriteChain
    .catch(() => {})
    .then(() => AsyncStorage.setItem(POST_VISIT_PROMPTED_KEY, JSON.stringify(Array.from(ids))))
    .catch(() => {
      /* best-effort; worst case is one re-prompt, not a crash */
    });
  return promptedWriteChain;
}

/** A scheduled visit time is "done" once it's 2–48h in the past — long enough that
 * it likely happened, not so long that the prompt feels stale. */
const PAST_PROMPT_MIN_AGE_MS = 2 * 3600_000;
const PAST_PROMPT_MAX_AGE_MS = 48 * 3600_000;

/** Shown once before a user's first publish; agreement is then persisted. */
async function ensureCommunityTermsAccepted(): Promise<boolean> {
  const accepted = await AsyncStorage.getItem(COMMUNITY_TERMS_KEY);
  if (accepted) return true;
  return new Promise((resolve) => {
    Alert.alert(
      "Community guidelines",
      "Publishing shares a trip with everyone. Keep it useful and respectful — no objectionable content. Reports are reviewed within 24 hours, and accounts that abuse the community are removed.",
      [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        {
          text: "I agree",
          onPress: async () => {
            await AsyncStorage.setItem(COMMUNITY_TERMS_KEY, new Date().toISOString());
            resolve(true);
          },
        },
      ],
    );
  });
}

/** Labeled +/- numeric control — friendlier than a bare keyboard field. */
function Stepper({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  min: number;
  max: number;
}) {
  const n = Number(value) || min;
  const set = (next: number) => onChange(String(Math.min(max, Math.max(min, next))));
  return (
    <View style={styles.stepper}>
      <Text style={type.caption}>{label}</Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Pressable style={styles.stepperButton} onPress={() => set(n - 1)} hitSlop={6}>
          <Ionicons name="remove" size={18} color={colors.primary} />
        </Pressable>
        <Text style={styles.stepperValue}>{n}</Text>
        <Pressable style={styles.stepperButton} onPress={() => set(n + 1)} hitSlop={6}>
          <Ionicons name="add" size={18} color={colors.primary} />
        </Pressable>
      </View>
    </View>
  );
}

/** YYYY-MM-DD in local time (Date#toISOString is UTC and shifts the day for non-UTC users). */
function localDateString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Date for a given 1-based trip day, from the trip's start date. */
function dayDate(startDate: string | null | undefined, day: number): string | null {
  if (!startDate) return null;
  const d = new Date(startDate + "T12:00:00");
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + (day - 1));
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

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
  const joinTrip = useJoinTrip();
  const { data: visitTimes } = useVisitTimes();
  const deleteVisitTime = useDeleteVisitTime();
  const upcoming = (visitTimes ?? []).filter((v) => new Date(v.at).getTime() > Date.now());

  useEffect(() => {
    if (visitTimes) reconcileReminders(visitTimes).catch(() => {});
  }, [visitTimes]);

  // Gentle "how did it go?" rail: visit times that already happened, whose
  // place has no rating yet, and that haven't been prompted (or dismissed)
  // before. `promptedIds` starts null until AsyncStorage resolves, and
  // `myLogs` starts undefined until its own fetch resolves — gating on both
  // keeps the rail hidden rather than flashing a row (for a place the user
  // already rated) and then disappearing once myLogs catches up.
  const { data: myLogs } = useMyLogs();
  // Mirrors `promptedIds` state but updated synchronously (not batched), so
  // two dismissals fired back-to-back both see the other's addition instead
  // of racing off the same stale snapshot.
  const promptedIdsRef = useRef<Set<string> | null>(null);
  const [promptedIds, setPromptedIds] = useState<Set<string> | null>(null);
  useEffect(() => {
    getPromptedVisitIds().then((ids) => {
      promptedIdsRef.current = ids;
      setPromptedIds(ids);
    });
  }, []);
  const [postVisitTarget, setPostVisitTarget] = useState<{ id: string; placeId: string } | null>(null);

  // Once both the prompted-ids set and visit times are loaded, drop any
  // prompted id whose visit has aged out of the prompt window — it can
  // never surface the rail again anyway, so there's no reason to keep it
  // (and the on-disk list) growing forever.
  useEffect(() => {
    if (!visitTimes || !promptedIdsRef.current) return;
    const byId = new Map(visitTimes.map((v) => [v.id, v]));
    let changed = false;
    const pruned = new Set<string>();
    for (const id of promptedIdsRef.current) {
      const v = byId.get(id);
      const age = v ? Date.now() - new Date(v.at).getTime() : null;
      if (age != null && age > PAST_PROMPT_MAX_AGE_MS) {
        changed = true;
        continue;
      }
      pruned.add(id);
    }
    if (changed) {
      promptedIdsRef.current = pruned;
      setPromptedIds(pruned);
      persistPromptedIds(pruned).catch(() => {});
    }
    // Re-runs once promptedIds first hydrates from storage (it and
    // visitTimes load independently/async, so whichever resolves second is
    // what actually lets this prune) and, harmlessly, after any dismissal —
    // `changed` is false on those re-checks, so it's a no-op past the first.
  }, [visitTimes, promptedIds]);

  const ratedPlaceIds = new Set((myLogs ?? []).filter((l) => l.rating != null).map((l) => l.place_id));
  const pastPrompts = promptedIds && myLogs !== undefined
    ? (visitTimes ?? []).filter((v) => {
        const age = Date.now() - new Date(v.at).getTime();
        if (age < PAST_PROMPT_MIN_AGE_MS || age > PAST_PROMPT_MAX_AGE_MS) return false;
        if (ratedPlaceIds.has(v.place.id)) return false;
        if (promptedIds.has(v.id)) return false;
        return true;
      })
    : [];

  const dismissPrompt = (id: string) => {
    const next = new Set(promptedIdsRef.current ?? promptedIds ?? []);
    next.add(id);
    promptedIdsRef.current = next;
    setPromptedIds(next);
    persistPromptedIds(next).catch(() => {});
  };

  const closePostVisit = () => {
    if (postVisitTarget) dismissPrompt(postVisitTarget.id);
    setPostVisitTarget(null);
  };

  const [region, setRegion] = useState("");
  const [days, setDays] = useState("3");
  const [stops, setStops] = useState("3");
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
        stops: Number(stops) || 3,
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

        {upcoming.length > 0 && (
          <View style={[styles.templateCard, { marginBottom: spacing.md }]}>
            <Text style={type.heading}>Upcoming {skin.vocab.visitTimes.toLowerCase()}</Text>
            {upcoming.map((v) => (
              <View key={v.id} style={styles.placeRow}>
                <Ionicons name="alarm" size={15} color={colors.accent} />
                <Pressable style={{ flex: 1 }} onPress={() => router.push(`/place/${v.place.slug}`)}>
                  <Text style={type.body} numberOfLines={1}>{v.place.name}</Text>
                  <Text style={type.caption}>
                    {new Date(v.at).toLocaleString([], {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </Text>
                </Pressable>
                <Pressable
                  hitSlop={8}
                  onPress={() => {
                    deleteVisitTime.mutate(v.id);
                    cancelVisitReminders(v.id).catch(() => {});
                  }}
                >
                  <Ionicons name="close-circle-outline" size={18} color={colors.textSecondary} />
                </Pressable>
              </View>
            ))}
          </View>
        )}

        {pastPrompts.length > 0 && (
          <View style={[styles.templateCard, { marginBottom: spacing.md }]}>
            <Text style={type.heading}>How did it go?</Text>
            {pastPrompts.map((v) => (
              <View key={v.id} style={styles.placeRow}>
                <Ionicons name="star-outline" size={15} color={colors.accent} />
                <Pressable
                  style={{ flex: 1 }}
                  onPress={() => setPostVisitTarget({ id: v.id, placeId: v.place.id })}
                >
                  <Text style={type.body} numberOfLines={1}>{v.place.name}</Text>
                  <Text style={type.caption}>
                    {new Date(v.at).toLocaleString([], {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                    })}
                  </Text>
                </Pressable>
                <Pressable hitSlop={8} onPress={() => dismissPrompt(v.id)}>
                  <Ionicons name="close-circle-outline" size={18} color={colors.textSecondary} />
                </Pressable>
              </View>
            ))}
          </View>
        )}

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
            <Stepper label={skin.vocab.tripStops} value={stops} onChange={setStops} min={1} max={20} />
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
            placeholder={skin.vocab.tripNotesHint}
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

        <CommunityTripsSection />

        <Text style={[type.heading, { marginTop: spacing.xl }]}>Trip ideas</Text>
        <Text style={[type.caption, { marginBottom: spacing.sm }]}>
          Editor-built trips, free for everyone.
        </Text>
        {skin.tripTemplates.map((t) => (
          <TemplateCard
            key={t.slug}
            template={t}
            onTune={(tuneRegion, tuneDays) => {
              setRegion(tuneRegion);
              setDays(String(tuneDays));
              setStops(String(tuneDays));
            }}
          />
        ))}

        <View style={{ flexDirection: "row", alignItems: "center", marginTop: spacing.xl, marginBottom: spacing.sm }}>
          <Text style={[type.heading, { flex: 1 }]}>Your trips</Text>
          <Pressable
            style={styles.joinButton}
            onPress={() =>
              Alert.prompt("Join a trip", "Enter the 6-letter invite code", async (code) => {
                if (!code?.trim()) return;
                try {
                  await joinTrip.mutateAsync(code.trim());
                } catch {
                  Alert.alert("Couldn't join", "Check the code and try again.");
                }
              })
            }
          >
            <Ionicons name="enter-outline" size={15} color={colors.primary} />
            <Text style={styles.joinButtonText}>Join a trip</Text>
          </Pressable>
        </View>
        {(savedPlans ?? []).length === 0 && (
          <Text style={type.caption}>Trips you build or join appear here.</Text>
        )}
        {(savedPlans ?? []).map((p) => (
          <TripCard key={p.id} plan={p} />
        ))}
      </ScrollView>
      {postVisitTarget && (
        <PostVisitSheet
          visible
          placeId={postVisitTarget.placeId}
          note={myLogs?.find((l) => l.place_id === postVisitTarget.placeId)?.note ?? null}
          onClose={closePostVisit}
        />
      )}
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

function Itinerary({
  itinerary,
  title,
  startDate,
}: {
  itinerary: TripItinerary;
  title?: string;
  startDate?: string | null;
}) {
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
          <Text style={[type.caption, { fontWeight: "700", color: colors.primary }]}>
            DAY {d.day}{dayDate(startDate, d.day) ? ` · ${dayDate(startDate, d.day)}` : ""}
          </Text>
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

/** Trips other users have published; renders nothing when the feed is empty. */
function CommunityTripsSection() {
  const { data: trips } = usePublishedTrips();
  if (!trips || trips.length === 0) return null;
  // already ordered server-side (editor_pick, then votes)
  return (
    <View style={{ marginTop: spacing.xl }}>
      <Text style={type.heading}>Community trips</Text>
      <Text style={[type.caption, { marginBottom: spacing.sm }]}>Published by other members.</Text>
      {trips.map((t) => (
        <CommunityTripCard key={t.id} trip={t} />
      ))}
    </View>
  );
}

function CommunityTripCard({ trip }: { trip: PublishedTrip }) {
  const { session } = useAuth();
  const voteTrip = useVoteTrip();
  const unvoteTrip = useUnvoteTrip();
  const adoptTrip = useAdoptTrip();
  const reportContent = useReportContent();
  const blockUser = useBlockUser();
  const [voted, setVoted] = useState(false);
  const [adopted, setAdopted] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const toggleVote = () => {
    Haptics.selectionAsync().catch(() => {});
    const next = !voted;
    setVoted(next);
    if (next) voteTrip.mutate(trip.id);
    else unvoteTrip.mutate(trip.id);
  };

  const adopt = async () => {
    try {
      await adoptTrip.mutateAsync(trip.id);
      setAdopted(true);
      Alert.alert("Added", "This trip is now yours to edit under Your trips.");
    } catch {
      Alert.alert("Couldn't add", "Please try again.");
    }
  };

  const report = () => {
    setMenuOpen(false);
    Alert.prompt(
      "Report this trip",
      "Briefly tell us what's wrong",
      async (reason) => {
        try {
          await reportContent.mutateAsync({
            targetType: "trip",
            targetId: trip.id,
            reason: reason?.trim() || "unspecified",
          });
          Alert.alert("Reported", "Thanks — we review reports within 24 hours.");
        } catch {
          Alert.alert("Couldn't report", "Please try again.");
        }
      },
      "plain-text",
    );
  };

  const block = () => {
    setMenuOpen(false);
    Alert.alert(`Block @${trip.author_handle ?? "this member"}?`, "You won't see their published trips anymore.", [
      { text: "Cancel", style: "cancel" },
      { text: "Block", style: "destructive", onPress: () => blockUser.mutate(trip.author_id) },
    ]);
  };

  return (
    <View style={styles.templateCard}>
      <View style={{ flexDirection: "row", alignItems: "flex-start" }}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
            <Text style={type.heading} numberOfLines={1}>{trip.title}</Text>
            {trip.editor_pick && (
              <View style={styles.editorPickPill}>
                <Text style={styles.editorPickText}>Editor's pick</Text>
              </View>
            )}
          </View>
          <Text style={type.caption}>@{trip.author_handle ?? "member"}</Text>
          <Text style={type.caption}>{trip.days} days · {trip.stops} stops</Text>
        </View>
        <Pressable hitSlop={8} onPress={() => setMenuOpen(!menuOpen)}>
          <Ionicons name="ellipsis-horizontal" size={18} color={colors.textSecondary} />
        </Pressable>
      </View>
      {menuOpen && (
        <View style={styles.tripActions}>
          <Pressable style={styles.tripAction} onPress={report}>
            <Ionicons name="flag-outline" size={15} color={colors.textSecondary} />
            <Text style={styles.tripActionText}>Report</Text>
          </Pressable>
          {trip.author_id !== session?.user.id && (
            <Pressable style={styles.tripAction} onPress={block}>
              <Ionicons name="person-remove-outline" size={15} color="#B4552D" />
              <Text style={[styles.tripActionText, { color: "#B4552D" }]}>Block author</Text>
            </Pressable>
          )}
        </View>
      )}
      {trip.summary ? <Text style={[type.caption, { marginTop: spacing.xs }]}>{trip.summary}</Text> : null}
      <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm }}>
        <Pressable style={[styles.voteButton, voted && styles.voteButtonActive]} onPress={toggleVote}>
          <Ionicons name="triangle" size={12} color={voted ? "#FFF" : colors.primary} />
          <Text style={[styles.voteText, voted && { color: "#FFF" }]}>{trip.votes}</Text>
        </Pressable>
        <Pressable
          style={[styles.generate, { flex: 1, height: 42 }, (adopted || adoptTrip.isPending) && { opacity: 0.7 }]}
          disabled={adopted || adoptTrip.isPending}
          onPress={adopt}
        >
          <Text style={[styles.generateText, { fontSize: 14 }]}>
            {adopted ? "Added to your trips ✓" : "Make it my trip"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

/** A saved trip: viewable, editable, and shareable with friends by code. */
function TripCard({ plan }: { plan: TripPlan }) {
  const { session } = useAuth();
  const deleteTrip = useDeleteTrip();
  const publishTrip = usePublishTrip();
  const unpublishTrip = useUnpublishTrip();
  const { data: publishedTrips } = usePublishedTrips();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const isOwner = plan.user_id === session?.user.id;
  const title = plan.title ?? plan.request.region;
  const isPublished = (publishedTrips ?? []).some((t) => t.id === plan.id);

  const publish = async () => {
    const ok = await ensureCommunityTermsAccepted();
    if (!ok) return;
    Alert.prompt(
      "Publish this trip",
      "Give it a title",
      (t) => {
        const publishTitle = t?.trim() || title;
        Alert.prompt(
          "One-line summary",
          "What makes this trip worth trying?",
          async (s) => {
            try {
              await publishTrip.mutateAsync({ tripId: plan.id, title: publishTitle, summary: s?.trim() ?? "" });
            } catch (e) {
              const code = (e as Error).message;
              if (code === "invalid_title") {
                Alert.alert("Couldn't publish", "Give the trip a title first.");
              } else {
                Alert.alert("Couldn't publish", "Please try again.");
              }
            }
          },
          "plain-text",
        );
      },
      "plain-text",
      title,
    );
  };

  const invite = () => {
    Alert.alert(
      "Invite friends to this trip",
      `Code: ${plan.invite_code}\n\nAnyone with the code can view and edit this trip.`,
      [
        {
          text: "Share code",
          onPress: () =>
            Share.share({
              message: `Help me plan "${title}" in ${skin.vocab.appName}: open the app, go to Trips → Join a trip, and enter code ${plan.invite_code}.`,
            }).catch(() => {}),
        },
        { text: "Done", style: "cancel" },
      ],
    );
  };

  return (
    <View style={styles.templateCard}>
      <Pressable style={{ flexDirection: "row", alignItems: "center" }} onPress={() => setOpen(!open)}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
            <Text style={type.heading} numberOfLines={1}>{title}</Text>
            {!isOwner && (
              <View style={styles.sharedBadge}>
                <Text style={styles.sharedBadgeText}>Shared</Text>
              </View>
            )}
          </View>
          <Text style={type.caption}>
            {plan.start_date ? `${dayDate(plan.start_date, 1)} · ` : ""}
            {plan.itinerary.days.length} days · {plan.itinerary.days.reduce((n, d) => n + d.places.length, 0)} stops
          </Text>
        </View>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={18} color={colors.textSecondary} />
      </Pressable>
      {open && !editing && (
        <>
          <View style={styles.tripActions}>
            <Pressable style={styles.tripAction} onPress={() => setEditing(true)}>
              <Ionicons name="create-outline" size={16} color={colors.primary} />
              <Text style={styles.tripActionText}>Edit</Text>
            </Pressable>
            <Pressable style={styles.tripAction} onPress={invite}>
              <Ionicons name="person-add-outline" size={16} color={colors.primary} />
              <Text style={styles.tripActionText}>Invite</Text>
            </Pressable>
            {isOwner && (
              <Pressable
                style={styles.tripAction}
                disabled={publishTrip.isPending || unpublishTrip.isPending}
                onPress={() => (isPublished ? unpublishTrip.mutate(plan.id) : publish())}
              >
                <Ionicons
                  name={isPublished ? "cloud-offline-outline" : "cloud-upload-outline"}
                  size={16}
                  color={colors.primary}
                />
                <Text style={styles.tripActionText}>{isPublished ? "Unpublish" : "Publish"}</Text>
              </Pressable>
            )}
            {isOwner && (
              <Pressable
                style={styles.tripAction}
                onPress={() =>
                  Alert.alert("Delete trip?", `"${title}" will be removed for everyone on it.`, [
                    { text: "Cancel", style: "cancel" },
                    { text: "Delete", style: "destructive", onPress: () => deleteTrip.mutate(plan.id) },
                  ])
                }
              >
                <Ionicons name="trash-outline" size={16} color="#B4552D" />
                <Text style={[styles.tripActionText, { color: "#B4552D" }]}>Delete</Text>
              </Pressable>
            )}
          </View>
          <Itinerary itinerary={plan.itinerary} title={title} startDate={plan.start_date} />
        </>
      )}
      {open && editing && <TripEditor plan={plan} onDone={() => setEditing(false)} />}
    </View>
  );
}

/** In-place itinerary editor: title, start date, stops and days. */
function TripEditor({ plan, onDone }: { plan: TripPlan; onDone: () => void }) {
  const updateTrip = useUpdateTrip();
  const [title, setTitle] = useState(plan.title ?? plan.request.region);
  const [startDate, setStartDate] = useState<string | null>(plan.start_date);
  const [dateOpen, setDateOpen] = useState(false);
  const [days, setDays] = useState<TripItinerary["days"]>(
    () => JSON.parse(JSON.stringify(plan.itinerary.days)),
  );
  const [addingTo, setAddingTo] = useState<number | null>(null);
  const [stopQuery, setStopQuery] = useState("");

  // Once the user edits anything, stop clobbering their changes with fresh
  // server data; re-seed only while the editor is still untouched.
  const dirty = useRef(false);
  const markDirty = () => {
    dirty.current = true;
  };
  useEffect(() => {
    if (dirty.current) return;
    setTitle(plan.title ?? plan.request.region);
    setStartDate(plan.start_date);
    setDays(JSON.parse(JSON.stringify(plan.itinerary.days)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.itinerary, plan.title, plan.start_date]);

  const renumber = (list: TripItinerary["days"]) =>
    list.map((d, i) => ({ ...d, day: i + 1 }));

  const removeStop = (dayIdx: number, placeId: string) => {
    markDirty();
    setDays((prev) =>
      prev.map((d, i) => (i === dayIdx ? { ...d, places: d.places.filter((p) => p.id !== placeId) } : d)),
    );
  };

  const addStop = async (dayIdx: number, slug: string) => {
    try {
      const place = await fetchPlaceBySlug(slug);
      markDirty();
      setDays((prev) =>
        prev.map((d, i) =>
          i === dayIdx && !d.places.some((p) => p.id === place.id)
            ? { ...d, places: [...d.places, place] }
            : d,
        ),
      );
      setStopQuery("");
      setAddingTo(null);
    } catch {
      Alert.alert("Couldn't add", "Please try again.");
    }
  };

  const save = async () => {
    try {
      await updateTrip.mutateAsync({
        tripId: plan.id,
        patch: {
          title: title.trim() || null,
          start_date: startDate,
          itinerary: { ...plan.itinerary, days: renumber(days) },
        },
      });
      onDone();
    } catch {
      Alert.alert("Couldn't save", "Please try again.");
    }
  };

  const results = stopQuery.length >= 2 ? searchPins(stopQuery, 5) : [];

  return (
    <View style={styles.resultCard}>
      <TextInput
        style={styles.input}
        value={title}
        onChangeText={(v) => {
          markDirty();
          setTitle(v);
        }}
        placeholder="Trip name"
        placeholderTextColor={colors.textSecondary}
      />
      <Pressable style={styles.dateRow} onPress={() => setDateOpen(!dateOpen)}>
        <Ionicons name="calendar-outline" size={17} color={colors.primary} />
        <Text style={[type.body, { flex: 1 }]}>
          {startDate ? `Starts ${dayDate(startDate, 1)}` : "Set a start date"}
        </Text>
        {startDate && (
          <Pressable
            hitSlop={8}
            onPress={() => {
              markDirty();
              setStartDate(null);
            }}
          >
            <Ionicons name="close-circle-outline" size={17} color={colors.textSecondary} />
          </Pressable>
        )}
      </Pressable>
      {dateOpen && (
        <DateTimePicker
          value={startDate ? new Date(startDate + "T12:00:00") : new Date()}
          mode="date"
          display="inline"
          onChange={(_e, d) => {
            if (d) {
              markDirty();
              setStartDate(localDateString(d));
            }
            setDateOpen(false);
          }}
        />
      )}

      {days.map((d, dayIdx) => (
        <View key={dayIdx} style={{ marginTop: spacing.md }}>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Text style={[type.caption, { fontWeight: "700", color: colors.primary, flex: 1 }]}>
              DAY {dayIdx + 1}{dayDate(startDate, dayIdx + 1) ? ` · ${dayDate(startDate, dayIdx + 1)}` : ""}
            </Text>
            {days.length > 1 && (
              <Pressable
                hitSlop={8}
                onPress={() => {
                  markDirty();
                  setDays((prev) => renumber(prev.filter((_x, i) => i !== dayIdx)));
                }}
              >
                <Ionicons name="trash-outline" size={15} color={colors.textSecondary} />
              </Pressable>
            )}
          </View>
          {d.places.map((p) => (
            <View key={p.id} style={styles.placeRow}>
              <Ionicons name="flag" size={14} color={colors.accent} />
              <View style={{ flex: 1 }}>
                <Text style={type.body} numberOfLines={1}>{p.name}</Text>
                <Text style={type.caption}>{[p.city, p.region].filter(Boolean).join(", ")}</Text>
              </View>
              <Pressable hitSlop={8} onPress={() => removeStop(dayIdx, p.id)}>
                <Ionicons name="close-circle-outline" size={18} color={colors.textSecondary} />
              </Pressable>
            </View>
          ))}
          {addingTo === dayIdx ? (
            <View>
              <TextInput
                style={[styles.input, { marginTop: spacing.xs }]}
                value={stopQuery}
                onChangeText={setStopQuery}
                placeholder={`Search ${skin.vocab.places}…`}
                placeholderTextColor={colors.textSecondary}
                autoFocus
              />
              {results.map((r) => (
                <Pressable key={r.slug} style={styles.placeRow} onPress={() => addStop(dayIdx, r.slug)}>
                  <Ionicons name="add" size={15} color={colors.primary} />
                  <View style={{ flex: 1 }}>
                    <Text style={type.body} numberOfLines={1}>{r.name}</Text>
                    <Text style={type.caption}>{[r.city, r.region].filter(Boolean).join(", ")}</Text>
                  </View>
                </Pressable>
              ))}
            </View>
          ) : (
            <Pressable
              style={styles.addStop}
              onPress={() => {
                setAddingTo(dayIdx);
                setStopQuery("");
              }}
            >
              <Ionicons name="add" size={15} color={colors.primary} />
              <Text style={styles.tripActionText}>Add a stop</Text>
            </Pressable>
          )}
        </View>
      ))}

      <Pressable
        style={styles.addStop}
        onPress={() => {
          markDirty();
          setDays((prev) => renumber([...prev, { day: prev.length + 1, note: "", places: [] }]));
        }}
      >
        <Ionicons name="add-circle-outline" size={16} color={colors.primary} />
        <Text style={styles.tripActionText}>Add a day</Text>
      </Pressable>

      <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.md }}>
        <Pressable style={[styles.generate, { flex: 1, height: 44 }]} onPress={save} disabled={updateTrip.isPending}>
          <Text style={styles.generateText}>{updateTrip.isPending ? "Saving…" : "Save trip"}</Text>
        </Pressable>
        <Pressable style={styles.cancelButton} onPress={onDone}>
          <Text style={[styles.tripActionText, { fontSize: 15 }]}>Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}

function TemplateCard({
  template,
  onTune,
}: {
  template: TripTemplate;
  onTune: (region: string, days: number) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { data: places } = useTemplatePlaces(template.placeSlugs);
  const createTrip = useCreateTrip();
  const [adopted, setAdopted] = useState(false);

  // distribute the template's stops evenly across its day count
  const adopt = async () => {
    if (!places?.length) return;
    const perDay = Math.ceil(places.length / template.days);
    const days = Array.from({ length: template.days }, (_x, i) => ({
      day: i + 1,
      note: "",
      places: places.slice(i * perDay, (i + 1) * perDay),
    })).filter((d) => d.places.length > 0);
    try {
      await createTrip.mutateAsync({
        title: template.title,
        itinerary: { summary: template.description, days },
      });
      setAdopted(true);
    } catch {
      Alert.alert("Couldn't save", "Please try again.");
    }
  };

  return (
    <View style={styles.templateCard}>
      <Pressable style={{ flexDirection: "row", alignItems: "center" }} onPress={() => setOpen(!open)}>
        <View style={{ flex: 1 }}>
          <Text style={type.heading}>{template.title}</Text>
          <Text style={type.caption}>{template.description}</Text>
        </View>
        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={18} color={colors.textSecondary} />
      </Pressable>
      {open && (
        <>
          {(places ?? []).map((p) => (
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
          <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.sm }}>
            <Pressable
              style={[styles.generate, { flex: 1, height: 42 }, (adopted || createTrip.isPending) && { opacity: 0.7 }]}
              disabled={adopted || createTrip.isPending || !places?.length}
              onPress={adopt}
            >
              <Text style={[styles.generateText, { fontSize: 14 }]}>
                {adopted ? "Added to your trips ✓" : "Make it my trip"}
              </Text>
            </Pressable>
            <Pressable
              style={styles.cancelButton}
              onPress={() => onTune(places?.[0]?.region ?? "", template.days)}
            >
              <Text style={[styles.tripActionText, { fontSize: 14 }]}>Tune it</Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
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
  budgetRow: { flexDirection: "row", gap: spacing.xs },
  budgetChip: {
    paddingHorizontal: spacing.md,
    height: 34,
    borderRadius: 3,
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
    borderRadius: 4,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
  },
  generateText: { color: "#FFF", fontSize: 16, fontWeight: "700" },
  resultCard: {
    backgroundColor: colors.surface,
    borderRadius: 4,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  saveAll: {
    flexDirection: "row",
    gap: spacing.xs,
    height: 42,
    borderRadius: 3,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.accentFill,
    marginTop: spacing.md,
  },
  saveAllText: { color: "#FFF", fontSize: 14, fontWeight: "700" },
  templateCard: {
    backgroundColor: colors.surface,
    borderRadius: 4,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  placeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#E7E7E3",
  },
  joinButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1.5,
    borderColor: colors.primary,
    borderRadius: 4,
    paddingHorizontal: spacing.sm,
    height: 32,
    backgroundColor: colors.surface,
  },
  joinButtonText: { fontSize: 13, fontWeight: "700", color: colors.primary },
  sharedBadge: {
    backgroundColor: colors.accentFill,
    borderRadius: 2,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  sharedBadgeText: { fontSize: 10, fontWeight: "800", color: "#FFF", letterSpacing: 0.5 },
  editorPickPill: {
    backgroundColor: colors.accentFill,
    borderRadius: radii.chip,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  editorPickText: { fontSize: 10, fontWeight: "800", color: "#FFF", letterSpacing: 0.5 },
  voteButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1.5,
    borderColor: colors.primary,
    borderRadius: radii.control,
    paddingHorizontal: spacing.sm,
    height: 42,
    backgroundColor: colors.surface,
  },
  voteButtonActive: { backgroundColor: colors.primary },
  voteText: { fontSize: 14, fontWeight: "700", color: colors.primary },
  tripActions: {
    flexDirection: "row",
    gap: spacing.lg,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#E7E7E3",
  },
  tripAction: { flexDirection: "row", alignItems: "center", gap: 4 },
  tripActionText: { fontSize: 13, fontWeight: "700", color: colors.primary },
  dateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    marginTop: spacing.xs,
  },
  addStop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: spacing.sm,
  },
  cancelButton: {
    paddingHorizontal: spacing.md,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
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
});
