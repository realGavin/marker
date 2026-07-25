/**
 * Public runtime config. EXPO_PUBLIC_* vars are compiled into the app bundle —
 * only ever put publishable values here (the Supabase anon key is designed to
 * be public; real protection is RLS). Secrets live server-side only.
 */
export const env = {
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "",
};

export const isBackendConfigured =
  env.supabaseUrl.startsWith("https://") && env.supabaseAnonKey.length > 20;
