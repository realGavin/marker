import React from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AuthProvider, useAuth } from "../providers/auth";
import { QueryProvider } from "../providers/query";
import { isBackendConfigured } from "../lib/env";
import { colors } from "../ui/theme";
import { ActivityIndicator, View } from "react-native";

function Gate() {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.background }}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const signedIn = isBackendConfigured && !!session;

  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen
          name="place/[slug]"
          options={{ headerShown: true, headerStyle: { backgroundColor: colors.background }, headerTintColor: colors.primary, title: "" }}
        />
        <Stack.Screen
          name="list/[id]"
          options={{ headerShown: true, headerStyle: { backgroundColor: colors.background }, headerTintColor: colors.primary, title: "" }}
        />
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
      <QueryProvider>
        <StatusBar style="dark" />
        <Gate />
      </QueryProvider>
    </AuthProvider>
  );
}
