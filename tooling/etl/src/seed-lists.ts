import { readFile } from "node:fs/promises";
import { curatedLists } from "../../../packages/skins/golf/seeds/curated-lists.js";

async function loadDotEnv(): Promise<void> {
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

/** Upsert curated lists + items. Idempotent: keyed on (niche_id, slug). */
export async function seedLists(): Promise<void> {
  await loadDotEnv();
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SECRET_KEY missing in tooling/etl/.env");
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

  for (const seed of curatedLists) {
    // upsert list
    const listRes = await fetch(`${url}/rest/v1/lists?on_conflict=niche_id,slug`, {
      method: "POST",
      headers: { ...headers, Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify([{ owner_id: null, slug: seed.slug, title: seed.title, description: seed.description, niche_id: "golf" }]),
    });
    if (!listRes.ok) throw new Error(`list upsert ${seed.slug}: ${listRes.status} ${await listRes.text()}`);
    const [list] = (await listRes.json()) as Array<{ id: string }>;

    // resolve slugs -> place ids
    const slugParam = seed.placeSlugs.map((s) => `"${s}"`).join(",");
    const placesRes = await fetch(`${url}/rest/v1/places?niche_id=eq.golf&slug=in.(${slugParam})&select=id,slug`, { headers });
    if (!placesRes.ok) throw new Error(`places lookup: ${placesRes.status}`);
    const places = (await placesRes.json()) as Array<{ id: string; slug: string }>;
    const bySlug = new Map(places.map((p) => [p.slug, p.id]));
    const missing = seed.placeSlugs.filter((s) => !bySlug.has(s));
    if (missing.length) console.warn(`${seed.slug}: ${missing.length} slugs not in DB: ${missing.join(", ")}`);

    // upsert items with stable positions
    const items = seed.placeSlugs
      .filter((s) => bySlug.has(s))
      .map((s, i) => ({ list_id: list!.id, place_id: bySlug.get(s)!, position: i }));
    const itemsRes = await fetch(`${url}/rest/v1/list_items?on_conflict=list_id,place_id`, {
      method: "POST",
      headers: { ...headers, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(items),
    });
    if (!itemsRes.ok) throw new Error(`items upsert ${seed.slug}: ${itemsRes.status} ${await itemsRes.text()}`);
    console.log(`${seed.slug}: "${seed.title}" seeded with ${items.length} places`);
  }
}
