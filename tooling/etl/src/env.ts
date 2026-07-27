import { readFile } from "node:fs/promises";

export async function loadDotEnv(): Promise<void> {
  try {
    const envText = await readFile(new URL("../.env", import.meta.url).pathname, "utf8");
    for (const line of envText.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
    }
  } catch {
    /* no .env */
  }
}

export function supabaseUrl(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL missing in tooling/etl/.env");
  return url;
}

export function serviceHeaders(): Record<string, string> {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw new Error("SUPABASE_SECRET_KEY missing in tooling/etl/.env");
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}
