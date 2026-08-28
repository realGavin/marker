import React from "react";
import { LogBox } from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

// Unsigned simulator builds can't touch the keychain, which trips a harmless
// push-registration read inside expo-notifications (we only use local
// notifications). Signed builds don't hit this at all.
LogBox.ignoreLogs([/ExpoPushTokenManager/, /persisted server registration/]);
import { AuthProvider, useAuth } from "../providers/auth";
import { PurchasesProvider } from "../providers/purchases";
import { useProfile } from "../lib/data";
import { QueryProvider } from "../providers/query";
import { isBackendConfigured } from "../lib/env";
import { colors } from "../ui/theme";
import { ActivityIndicator, View } from "react-native";
import { cancelLegacyReminders } from "../lib/reminders";

function Gate() {
  const { session, loading } = useAuth();
  const signedIn = isBackendConfigured && !!session;
  const { data: profile, isPending: profilePending } = useProfile();

  // Unconditional: needs no server data, only the on-device notification
  // queue, so it must not be gated on auth or a successful fetch — see
  // cancelLegacyReminders' own doc comment for why that matters. Lives here
  // (mounted once at app start) rather than in the Trips tab, because Expo
  // Router tabs are lazy: a tester who never opens Trips would otherwise
  // keep the legacy 24h/4h alarms (including the 3am one) queued forever.
  React.useEffect(() => {
    cancelLegacyReminders().catch(() => {});
  }, []);

  if (loading || (signedIn && profilePending)) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background }}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const needsOnboarding = signedIn && profile != null && profile.handle == null;

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Protected guard={signedIn && needsOnboarding}>
        <Stack.Screen name="onboarding" />
      </Stack.Protected>
      <Stack.Protected guard={signedIn && !needsOnboarding}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="place/[slug]"
          options={{ headerShown: true, headerStyle: { backgroundColor: colors.background }, headerTintColor: colors.primary, title: "" }}
        />
        <Stack.Screen
          name="list/[id]"
          options={{ headerShown: true, headerStyle: { backgroundColor: colors.background }, headerTintColor: colors.primary, title: "" }}
        />
        <Stack.Screen
          name="blocked"
          options={{ headerShown: true, headerStyle: { backgroundColor: colors.background }, headerTintColor: colors.primary, title: "" }}
        />
        <Stack.Screen
          name="friends"
          options={{ headerShown: true, headerStyle: { backgroundColor: colors.background }, headerTintColor: colors.primary, title: "" }}
        />
        <Stack.Screen
          name="friend/[id]"
          options={{ headerShown: true, headerStyle: { backgroundColor: colors.background }, headerTintColor: colors.primary, title: "" }}
        />
        <Stack.Screen name="paywall" options={{ presentation: "modal" }} />
      </Stack.Protected>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <PurchasesProvider>
        <QueryProvider>
          <StatusBar style="dark" />
          <Gate />
        </QueryProvider>
      </PurchasesProvider>
    </AuthProvider>
  );
}
