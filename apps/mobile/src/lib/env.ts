/**
 * Public runtime config. EXPO_PUBLIC_* vars are compiled into the app bundle —
 * only ever put publishable values here (the Supabase anon key is designed to
 * be public; real protection is RLS). Secrets live server-side only.
 */
export const env = {
  supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL ?? "",
  supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? "",
  /** z/x/y vector-tile endpoint. Dev default: local pmtiles server. */
  tileUrl:
    process.env.EXPO_PUBLIC_TILE_URL ??
    "http://127.0.0.1:8082/basemap-us/{z}/{x}/{y}.mvt",
  /** Aerial photo endpoint; {slug} is replaced per place. Empty = no photos. */
  photoUrl: process.env.EXPO_PUBLIC_PHOTO_URL ?? "",
};

/** Aerial photo URL for a place, or null when photos aren't configured. */
export function photoUrl(slug: string): string | null {
  return env.photoUrl ? env.photoUrl.replace("{slug}", slug) : null;
}

export const isBackendConfigured =
  env.supabaseUrl.startsWith("https://") && env.supabaseAnonKey.length > 20;
