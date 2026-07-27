import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { skin } from "../skin";
import { colors, spacing, type } from "../ui/theme";
import { useUpdateProfile, useUpsertLog } from "../lib/data";
import { pins, searchPins, type Pin } from "../lib/pins";
import { getSupabase } from "../lib/supabase";

const STATES = [...new Set(pins.map((p) => p.region))].sort();

export default function OnboardingScreen() {
  const [step, setStep] = useState(0);
  const [handle, setHandle] = useState("");
  const [handleError, setHandleError] = useState<string | null>(null);
  const [homeState, setHomeState] = useState<string | null>(null);
  const [picked, setPicked] = useState<Pin[]>([]);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const updateProfile = useUpdateProfile();
  const upsertLog = useUpsertLog();

  const results = useMemo(() => searchPins(query, 8), [query]);

  // Nothing is written until finish(): the root gate keys on profile.handle,
  // so an early write would yank the user out of onboarding mid-flow.
  const submitHandle = () => {
    const h = handle.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,24}$/.test(h)) {
      setHandleError("3-24 characters: letters, numbers, underscores.");
      return;
    }
    setHandleError(null);
    setStep(1);
  };

  const submitState = (s: string) => {
    setHomeState(s);
    setStep(2);
  };

  const finish = async () => {
    setSaving(true);
    try {
      await updateProfile.mutateAsync({
        handle: handle.trim().toLowerCase(),
        home_region: homeState,
      });
    } catch {
      setHandleError("That handle is taken — try another.");
      setStep(0);
      setSaving(false);
      return;
    }
    try {
      const supabase = getSupabase();
      for (const p of picked) {
        const { data } = await supabase!
          .from("places")
          .select("id")
          .eq("niche_id", skin.nicheId)
          .eq("slug", p.slug)
          .maybeSingle();
        if (data) await upsertLog.mutateAsync({ placeId: data.id, status: "visited" });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.progress}>
        {[0, 1, 2].map((i) => (
          <View key={i} style={[styles.progressDot, i <= step && { backgroundColor: colors.accent }]} />
        ))}
      </View>

      {step === 0 && (
        <View style={styles.step}>
          <Text style={type.title}>Claim your handle</Text>
          <Text style={[type.caption, { marginTop: spacing.xs, marginBottom: spacing.lg }]}>
            It signs your share card.
          </Text>
          <View style={styles.handleRow}>
            <Text style={styles.at}>@</Text>
            <TextInput
              style={styles.handleInput}
              placeholder="yourname"
              placeholderTextColor={colors.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
              value={handle}
              onChangeText={setHandle}
              maxLength={24}
            />
          </View>
          {handleError ? <Text style={[type.caption, { color: "#B4552D", marginTop: spacing.xs }]}>{handleError}</Text> : null}
          <Pressable
            style={[styles.cta, handle.trim().length < 3 && { opacity: 0.5 }]}
            onPress={submitHandle}
            disabled={handle.trim().length < 3}
          >
            <Text style={styles.ctaText}>Continue</Text>
          </Pressable>
        </View>
      )}

      {step === 1 && (
        <View style={[styles.step, { flex: 1 }]}>
          <Text style={type.title}>Where's home?</Text>
          <Text style={[type.caption, { marginTop: spacing.xs, marginBottom: spacing.md }]}>
            Your map will open here.
          </Text>
          <ScrollView contentContainerStyle={styles.stateGrid}>
            {STATES.map((s) => (
              <Pressable
                key={s}
                style={[styles.stateChip, homeState === s && styles.stateActive]}
                onPress={() => submitState(s)}
              >
                <Text style={[styles.stateText, homeState === s && { color: "#FFF" }]}>{s}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}

      {step === 2 && (
        <View style={[styles.step, { flex: 1 }]}>
          <Text style={type.title}>Mark a few you've {skin.vocab.visited.toLowerCase()}</Text>
          <Text style={[type.caption, { marginTop: spacing.xs, marginBottom: spacing.md }]}>
            Start your collection — you can always add more later.
          </Text>
          <TextInput
            style={styles.search}
            placeholder={`Search ${skin.vocab.places}…`}
            placeholderTextColor={colors.textSecondary}
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
          />
          <FlatList
            data={results}
            keyExtractor={(p) => p.slug}
            keyboardShouldPersistTaps="handled"
            style={{ flexGrow: 0, maxHeight: 260 }}
            renderItem={({ item }) => {
              const isPicked = picked.some((p) => p.slug === item.slug);
              return (
                <Pressable
                  style={styles.resultRow}
                  onPress={() =>
                    setPicked(isPicked ? picked.filter((p) => p.slug !== item.slug) : [...picked, item])
                  }
                >
                  <Ionicons
                    name={isPicked ? "checkmark-circle" : "add-circle-outline"}
                    size={22}
                    color={isPicked ? colors.primary : colors.textSecondary}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={type.body} numberOfLines={1}>{item.name}</Text>
                    <Text style={type.caption}>{item.region}</Text>
                  </View>
                </Pressable>
              );
            }}
          />
          {picked.length > 0 && (
            <Text style={[type.caption, { marginTop: spacing.sm }]}>
              {picked.length} picked
            </Text>
          )}
          <Pressable style={[styles.cta, saving && { opacity: 0.5 }]} onPress={finish} disabled={saving}>
            {saving ? (
              <ActivityIndicator color="#FFF" />
            ) : (
              <Text style={styles.ctaText}>{picked.length > 0 ? "Start exploring" : "Skip for now"}</Text>
            )}
          </Pressable>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background, paddingTop: 80 },
  progress: { flexDirection: "row", gap: 6, justifyContent: "center", marginBottom: spacing.xl },
  progressDot: { width: 24, height: 4, borderRadius: 2, backgroundColor: "#DDD8CC" },
  step: { paddingHorizontal: spacing.lg },
  handleRow: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#DDD8CC",
    borderRadius: 12,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
  },
  at: { fontSize: 20, fontWeight: "700", color: colors.accent, marginRight: 4 },
  handleInput: { flex: 1, height: 52, fontSize: 18, color: colors.textPrimary },
  cta: {
    marginTop: spacing.lg,
    height: 50,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
  },
  ctaText: { color: "#FFF", fontSize: 16, fontWeight: "700" },
  stateGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, paddingBottom: spacing.xl },
  stateChip: {
    width: 60,
    height: 44,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#DDD8CC",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
  },
  stateActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  stateText: { fontSize: 15, fontWeight: "600", color: colors.textPrimary },
  search: {
    borderWidth: 1,
    borderColor: "#DDD8CC",
    borderRadius: 10,
    paddingHorizontal: spacing.md,
    height: 46,
    backgroundColor: colors.surface,
    color: colors.textPrimary,
    marginBottom: spacing.sm,
  },
  resultRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#EEE9DD",
  },
});
