import React, { useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { colors, spacing, type } from "./theme";
import { useRefineTripPlan, useUndoTripPlan, type TripItinerary } from "../lib/data";

interface LogLine {
  text: string;
  /** "unmet" renders as a decline, not an applied change — the planner saying it couldn't do something rather than inventing it. */
  kind: "change" | "unmet";
}

/**
 * The persistent "keep editing this plan" bar shown under an itinerary.
 * Each send calls refine and replaces the itinerary in place; a short log of
 * what changed builds up above the input. The itinerary is the subject here
 * — this is just how you tell it what to change, not a chat transcript to
 * scroll through.
 *
 * Undo is a server call (plan-trip, mode: "undo"), not a local state
 * rewind: the revision it restores lives in a column only the server can
 * read, on purpose, so a second device or trip member refining the same
 * trip can never make this client's idea of "the previous itinerary" stale
 * and wrong. Its availability is driven by the server's own `revisionCount`
 * (>0 means there's something to pop), never guessed locally.
 */
export function TripConversation({
  tripId,
  itinerary,
  initialRefinementsRemaining = null,
  initialRevisionCount = 0,
  initialUnmet,
  onApply,
}: {
  tripId: string;
  itinerary: TripItinerary;
  /** Unknown (null) when reopening a trip whose remaining count we haven't asked about yet this session. */
  initialRefinementsRemaining?: number | null;
  /** How many undo steps the server already reports available (0 when unknown, e.g. a freshly reopened trip). */
  initialRevisionCount?: number;
  /** Non-empty when the request that produced the current itinerary couldn't be fully satisfied. */
  initialUnmet?: string;
  onApply: (next: TripItinerary) => void;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const refine = useRefineTripPlan();
  const undoTrip = useUndoTripPlan();
  const [instruction, setInstruction] = useState("");
  const [log, setLog] = useState<LogLine[]>(() => (initialUnmet ? [{ text: initialUnmet, kind: "unmet" }] : []));
  const [revisionCount, setRevisionCount] = useState(initialRevisionCount);
  const [refinementsRemaining, setRefinementsRemaining] = useState<number | null>(initialRefinementsRemaining);
  const [limitReached, setLimitReached] = useState(initialRefinementsRemaining === 0);
  const [errorText, setErrorText] = useState<string | null>(null);
  // Belt-and-suspenders against a double-tap landing two sends before
  // mutation.isPending has re-rendered the disabled button: checked and set
  // synchronously, not via state.
  const sendingRef = useRef(false);
  // Same guard, mirrored for undo — it was previously gated only on
  // `undoTrip.isPending`, which (like `pending`/`refine.isPending`) is React
  // state and can't stop a double-tap that lands both calls before the first
  // re-render.
  const undoingRef = useRef(false);

  const send = async () => {
    const text = instruction.trim();
    if (!text || sendingRef.current || limitReached) return;
    sendingRef.current = true;
    setErrorText(null);
    try {
      const res = await refine.mutateAsync({ tripId, instruction: text });
      onApply(res.itinerary);
      setLog((prev) => {
        const next = [...prev];
        if (res.changeSummary) next.push({ text: res.changeSummary, kind: "change" });
        if (res.unmet) next.push({ text: res.unmet, kind: "unmet" });
        return next;
      });
      setRefinementsRemaining(res.refinementsRemaining);
      setLimitReached(res.refinementsRemaining <= 0);
      setRevisionCount(res.revisionCount);
      setInstruction("");
    } catch (e) {
      const code = (e as Error).message;
      if (code === "refinement_limit") {
        // Can fire from the per-trip cap OR a separate monthly cap even
        // while refinementsRemaining still looked positive — the counter is
        // a display value, not a guarantee the next send will succeed.
        setLimitReached(true);
        setErrorText("You've used all your refinements for this trip.");
      } else if (code === "upgrade_required") {
        // Same paywall trips.tsx routes to on a blocked create — a free-tier
        // user spending their one refinement is the same "you're out, here's
        // the upsell" moment, not an error to apologize for.
        router.push("/paywall");
      } else if (code === "conflict") {
        // The turn is claimed before the model call, so a 409 here means
        // someone else's write landed first and this request never reached
        // the model — it did NOT just cost a wasted generation. The
        // itinerary this send was computed against is stale either way, so
        // refetch and let the user look at the real current plan rather
        // than blind-retrying the same instruction against it: a retry
        // without refetching just loses the same race again.
        qc.invalidateQueries({ queryKey: ["trips"] });
        setErrorText("This trip changed elsewhere. Review the refreshed plan and try again.");
      } else if (code === "save_failed") {
        // The model ran and produced an itinerary, but it couldn't be
        // persisted — onApply is only ever called on success above, so
        // nothing renders here and the trip keeps its last-saved itinerary.
        // This one did cost a real model call, so say so rather than using
        // the generic message.
        setErrorText("We built a change but couldn't save it. Try again.");
      } else if (code === "quota_unavailable") {
        // Quota check failed server-side; the turn was refused rather than
        // spent unmetered. Transient — same affordance as any other retry.
        setErrorText("Couldn't check your refinement allowance. Try again in a moment.");
      } else if (code === "not_owner") {
        setErrorText("Only the trip owner can refine this trip.");
      } else if (code === "not_found") {
        setErrorText("This trip couldn't be found anymore.");
      } else {
        setErrorText("Couldn't apply that change. Try again.");
      }
    } finally {
      sendingRef.current = false;
    }
  };

  const undo = async () => {
    if (undoingRef.current || undoTrip.isPending || revisionCount <= 0) return;
    undoingRef.current = true;
    try {
      const res = await undoTrip.mutateAsync({ tripId });
      onApply(res.itinerary);
      setLog((prev) => [...prev, { text: "Undid the last change", kind: "change" }]);
      setRevisionCount(res.revisionCount);
      // Undo makes no model call, so it never costs a refinement — leave
      // refinementsRemaining exactly as it was.
    } catch {
      // "Nothing to undo" and any other undo failure both read the same way
      // to the user: the control disappears rather than an error toast for
      // what is, at worst, a missed convenience.
      setRevisionCount(0);
    } finally {
      undoingRef.current = false;
    }
  };

  return (
    <View style={styles.wrap}>
      {log.length > 0 && (
        <View style={styles.log}>
          {log.map((line, i) => (
            <View key={i} style={styles.logRow}>
              <Ionicons
                name={line.kind === "unmet" ? "information-circle-outline" : "checkmark-circle-outline"}
                size={13}
                color={line.kind === "unmet" ? colors.textSecondary : colors.accent}
              />
              <Text style={[type.caption, { flex: 1 }, line.kind === "unmet" && { fontStyle: "italic" }]}>
                {line.text}
              </Text>
            </View>
          ))}
        </View>
      )}
      {errorText ? <Text style={[type.caption, { color: "#B4552D", marginBottom: spacing.xs }]}>{errorText}</Text> : null}
      <View style={styles.row}>
        <TextInput
          style={[styles.input, limitReached && { opacity: 0.5 }]}
          placeholder={limitReached ? "No refinements left on this trip" : `e.g. "swap the second stop for something closer"`}
          placeholderTextColor={colors.textSecondary}
          value={instruction}
          onChangeText={setInstruction}
          editable={!limitReached && !refine.isPending}
          multiline
        />
        <Pressable
          style={[styles.sendButton, (refine.isPending || limitReached || !instruction.trim()) && { opacity: 0.5 }]}
          onPress={send}
          disabled={refine.isPending || limitReached || !instruction.trim()}
        >
          {refine.isPending ? (
            <ActivityIndicator color="#FFF" size="small" />
          ) : (
            <Ionicons name="arrow-up" size={16} color="#FFF" />
          )}
        </Pressable>
      </View>
      <View style={styles.footerRow}>
        {revisionCount > 0 && (
          <Pressable style={styles.undoButton} onPress={undo} disabled={undoTrip.isPending}>
            <Ionicons name="arrow-undo-outline" size={13} color={colors.primary} />
            <Text style={styles.undoText}>Undo</Text>
          </Pressable>
        )}
        <Text style={[type.caption, { flex: 1, textAlign: "right" }]}>
          {refinementsRemaining == null
            ? "Ask to change anything about this trip"
            : limitReached
              ? "No refinements left"
              : `${refinementsRemaining} refinement${refinementsRemaining === 1 ? "" : "s"} left`}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: spacing.sm },
  log: { gap: 4, marginBottom: spacing.xs },
  logRow: { flexDirection: "row", alignItems: "flex-start", gap: 6 },
  row: { flexDirection: "row", gap: spacing.sm, alignItems: "flex-end" },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#DADAD6",
    borderRadius: 3,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    backgroundColor: colors.surface,
    color: colors.textPrimary,
    fontSize: 14,
    maxHeight: 90,
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
  },
  footerRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: 6 },
  undoButton: { flexDirection: "row", alignItems: "center", gap: 4 },
  undoText: { fontSize: 12, fontWeight: "700", color: colors.primary },
});
