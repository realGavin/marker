import React from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { getSupabase } from "../lib/supabase";

/**
 * Query cache persisted to device storage: collection/lists render instantly
 * offline and after relaunch, then refresh from the server when reachable.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 7 * 24 * 3600_000,
      retry: 1,
    },
  },
});

const persister = createAsyncStoragePersister({ storage: AsyncStorage, key: "marker-query-cache" });

export function QueryProvider({ children }: { children: React.ReactNode }) {
  // No user data should survive sign-out in the persisted cache.
  React.useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) return;
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") queryClient.clear();
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{ persister, maxAge: 7 * 24 * 3600_000 }}
    >
      {children}
    </PersistQueryClientProvider>
  );
}
