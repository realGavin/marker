import React, { useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as AppleAuthentication from "expo-apple-authentication";
import Ionicons from "@expo/vector-icons/Ionicons";
import { skin } from "../skin";
import { getSupabase } from "../lib/supabase";
import { isBackendConfigured } from "../lib/env";
import { colors, spacing, type } from "../ui/theme";

/**
 * Value-prop carousel shown before sign-in. State-driven paging: programmatic
 * ScrollView.scrollTo is a silent no-op on this RN/Fabric version, so slides
 * swap by state and swipes are detected from raw touch deltas instead.
 */
function Intro({ onDone }: { onDone: () => void }) {
  const [page, setPage] = useState(0);
  const touchX = useRef(0);
  const slides = skin.introSlides;
  const last = page === slides.length - 1;
  const slide = slides[page]!;

  const go = (delta: number) =>
    setPage((p) => Math.min(Math.max(p + delta, 0), slides.length - 1));
  const next = () => (last ? onDone() : go(1));

  return (
    <View style={styles.introContainer}>
      <View
        style={styles.slide}
        onTouchStart={(e) => {
          touchX.current = e.nativeEvent.pageX;
        }}
        onTouchEnd={(e) => {
          const dx = e.nativeEvent.pageX - touchX.current;
          if (dx < -50) go(1);
          else if (dx > 50) go(-1);
        }}
      >
        <View style={styles.slideIcon}>
          <Ionicons name={slide.icon as never} size={44} color={colors.primary} />
        </View>
        <Text style={[type.title, { textAlign: "center" }]}>{slide.title}</Text>
        <Text style={[type.body, styles.slideBody]}>{slide.body}</Text>
      </View>

      <View style={styles.dots}>
        {slides.map((s, i) => (
          <View key={s.title} style={[styles.dot, i === page && styles.dotActive]} />
        ))}
      </View>
      <Pressable style={styles.introButton} onPress={next}>
        <Text style={styles.introButtonText}>{last ? "Get started" : "Next"}</Text>
      </Pressable>
      {!last && (
        <Pressable onPress={onDone} hitSlop={8}>
          <Text style={[type.caption, { textAlign: "center", marginTop: spacing.md }]}>Skip</Text>
        </Pressable>
      )}
    </View>
  );
}

export default function SignIn() {
  const [introDone, setIntroDone] = useState(false);
  if (!introDone && skin.introSlides.length > 0) {
    return <Intro onDone={() => setIntroDone(true)} />;
  }
  return <SignInForm />;
}

function SignInForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signIn" | "signUp">("signIn");
  const [busy, setBusy] = useState(false);
  const [appleAvailable, setAppleAvailable] = useState(false);

  React.useEffect(() => {
    AppleAuthentication.isAvailableAsync().then(setAppleAvailable).catch(() => {});
  }, []);

  if (!isBackendConfigured) {
    return (
      <View style={styles.container}>
        <Text style={type.title}>{skin.vocab.appName}</Text>
        <Text style={[type.body, { marginTop: spacing.md, textAlign: "center" }]}>
          Backend not configured yet.{"\n"}Add Supabase keys to apps/mobile/.env and restart.
        </Text>
      </View>
    );
  }

  const submitEmail = async () => {
    const supabase = getSupabase();
    if (!supabase) return;
    setBusy(true);
    try {
      const { error } =
        mode === "signIn"
          ? await supabase.auth.signInWithPassword({ email, password })
          : await supabase.auth.signUp({ email, password });
      if (error) Alert.alert("Sign in failed", error.message);
    } finally {
      setBusy(false);
    }
  };

  const submitApple = async () => {
    const supabase = getSupabase();
    if (!supabase) return;
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [AppleAuthentication.AppleAuthenticationScope.EMAIL],
      });
      if (credential.identityToken) {
        const { error } = await supabase.auth.signInWithIdToken({
          provider: "apple",
          token: credential.identityToken,
        });
        if (error) Alert.alert("Sign in failed", error.message);
      }
    } catch (e: unknown) {
      const err = e as { code?: string };
      if (err.code !== "ERR_REQUEST_CANCELED") {
        Alert.alert("Sign in failed", "Apple sign-in is unavailable.");
      }
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Text style={type.title}>{skin.vocab.appName}</Text>
      <Text style={[type.caption, { marginBottom: spacing.xl }]}>
        Your {skin.vocab.places}, on the map.
      </Text>

      {appleAvailable && (
        <AppleAuthentication.AppleAuthenticationButton
          buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
          buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
          cornerRadius={8}
          style={styles.appleButton}
          onPress={submitApple}
        />
      )}

      <TextInput
        style={styles.input}
        placeholder="Email"
        placeholderTextColor={colors.textSecondary}
        autoCapitalize="none"
        autoComplete="email"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        placeholderTextColor={colors.textSecondary}
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      <Pressable
        style={[styles.button, busy && { opacity: 0.6 }]}
        disabled={busy || !email || password.length < 8}
        onPress={submitEmail}
      >
        <Text style={styles.buttonText}>
          {mode === "signIn" ? "Sign in" : "Create account"}
        </Text>
      </Pressable>
      <Pressable onPress={() => setMode(mode === "signIn" ? "signUp" : "signIn")}>
        <Text style={[type.caption, { marginTop: spacing.md }]}>
          {mode === "signIn" ? "New here? Create an account" : "Have an account? Sign in"}
        </Text>
      </Pressable>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  introContainer: {
    flex: 1,
    backgroundColor: colors.background,
    paddingTop: 100,
    paddingBottom: 60,
  },
  slide: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
  },
  slideIcon: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#E8EFE9",
    marginBottom: spacing.lg,
  },
  slideBody: { textAlign: "center", marginTop: spacing.sm, color: colors.textSecondary },
  dots: {
    flexDirection: "row",
    gap: 8,
    alignSelf: "center",
    marginVertical: spacing.lg,
  },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#D5D0C4" },
  dotActive: { backgroundColor: colors.primary },
  introButton: {
    marginHorizontal: spacing.lg,
    height: 50,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
  },
  introButtonText: { color: "#FFF", fontSize: 16, fontWeight: "700" },
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.lg,
    backgroundColor: colors.background,
  },
  appleButton: { width: "100%", height: 48, marginBottom: spacing.md },
  input: {
    width: "100%",
    height: 48,
    borderWidth: 1,
    borderColor: "#DDD8CC",
    borderRadius: 8,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
    backgroundColor: colors.surface,
    color: colors.textPrimary,
  },
  button: {
    width: "100%",
    height: 48,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
    marginTop: spacing.xs,
  },
  buttonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
});
