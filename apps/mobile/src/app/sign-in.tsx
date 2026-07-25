import React, { useState } from "react";
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
import { skin } from "../skin";
import { getSupabase } from "../lib/supabase";
import { isBackendConfigured } from "../lib/env";
import { colors, spacing, type } from "../ui/theme";

export default function SignIn() {
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
