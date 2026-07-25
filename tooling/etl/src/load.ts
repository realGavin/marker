import { readFile } from "node:fs/promises";
import type { PlaceRow } from "./types.js";

const DATA = new URL("../data/", import.meta.url).pathname;

/**
 * Bulk upsert into public.places through the Data API using the SECRET
 * (service-role) key from tooling/etl/.env — the key that bypasses RLS.
 * Never ships in the app; never committed (data/ and .env are gitignored).
 */
async function loadDotEnv(): Promise<void> {
  try {
    const envText = await readFile(new URL("../.env", import.meta.url).pathname, "utf8");
    for (const line of envText.split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
    }
  } catch {
    /* no .env file */
  }
}

export async function load(): Promise<void> {
  await loadDotEnv();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing SUPABASE_URL / SUPABASE_SECRET_KEY.\n" +
        "Create tooling/etl/.env (gitignored) with both values; the secret key is in\n" +
        "Supabase Dashboard -> Project Settings -> API keys -> 'secret' key.",
    );
  }
  const rows: PlaceRow[] = JSON.parse(await readFile(DATA + "places.json", "utf8"));

  const BATCH = 500;
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH).map((r) => ({
      niche_id: r.niche_id,
      slug: r.slug,
      name: r.name,
      location: `SRID=4326;POINT(${r.lng} ${r.lat})`,
      city: r.city,
      region: r.region,
      country: r.country,
      attrs: r.attrs,
      source: r.source,
      source_ref: r.source_ref,
    }));
    const res = await fetch(`${url}/rest/v1/places?on_conflict=niche_id,slug`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(batch),
    });
    if (!res.ok) throw new Error(`batch ${i / BATCH}: HTTP ${res.status} ${await res.text()}`);
    done += batch.length;
    if (done % 2000 < BATCH) console.log(`loaded ${done}/${rows.length}`);
  }
  console.log(`load complete: ${done} rows upserted`);
}
