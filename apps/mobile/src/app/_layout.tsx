import React from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AuthProvider, useAuth } from "../providers/auth";
import { PurchasesProvider } from "../providers/purchases";
import { useProfile } from "../lib/data";
import { QueryProvider } from "../providers/query";
import { isBackendConfigured } from "../lib/env";
import { colors } from "../ui/theme";
import { ActivityIndicator, View } from "react-native";

function Gate() {
  const { session, loading } = useAuth();
  const signedIn = isBackendConfigured && !!session;
  const { data: profile, isPending: profilePending } = useProfile();

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
        <Stack.Screen name="paywall" options={{ presentation: "modal" }} />
        <Stack.Screen name="trips" />
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
