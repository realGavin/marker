import { readFile } from "node:fs/promises";
import type { PlaceRow } from "./types.js";
import { loadDotEnv, serviceHeaders, supabaseUrl } from "./env.js";

/**
 * Local embeddings: bge-small-en-v1.5 (384-dim) via transformers.js on this
 * machine. One-time cost: electricity. No metered API.
 */
export async function embed(): Promise<void> {
  await loadDotEnv();
  const url = supabaseUrl();
  const headers = serviceHeaders();

  const { pipeline } = await import("@xenova/transformers");
  const extractor = await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5");

  const rows: PlaceRow[] = JSON.parse(
    await readFile(new URL("../data/places.json", import.meta.url).pathname, "utf8"),
  );

  // fetch descriptions (if generated) so embeddings reflect them
  const descBySlug = new Map<string, string>();
  for (let from = 0; ; from += 1000) {
    const res = await fetch(
      `${url}/rest/v1/places?niche_id=eq.golf&select=slug,description&limit=1000&offset=${from}`,
      { headers },
    );
    const page = (await res.json()) as Array<{ slug: string; description: string | null }>;
    for (const p of page) if (p.description) descBySlug.set(p.slug, p.description);
    if (page.length < 1000) break;
  }

  const texts = rows.map((r) => {
    const a = r.attrs;
    return [
      r.name,
      [r.city, r.region].filter(Boolean).join(", "),
      a.access && a.access !== "unknown" ? `${a.access} access` : "",
      a.holes ? `${a.holes} holes` : "",
      descBySlug.get(r.slug) ?? "",
    ]
      .filter(Boolean)
      .join(". ");
  });

  const BATCH = 64;
  let updated = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = texts.slice(i, i + BATCH);
    const out = await extractor(chunk, { pooling: "mean", normalize: true });
    const dims = out.dims as [number, number];
    const flat = out.data as Float32Array;
    const payload = rows.slice(i, i + BATCH).map((r, j) => ({
      niche_id: r.niche_id,
      slug: r.slug,
      name: r.name,
      location: `POINT(${r.lng} ${r.lat})`,
      country: r.country,
      source: r.source,
      embedding: JSON.stringify(Array.from(flat.slice(j * dims[1], (j + 1) * dims[1]))),
    }));
    const res = await fetch(`${url}/rest/v1/places?on_conflict=niche_id,slug`, {
      method: "POST",
      headers: { ...headers, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`embed upsert @${i}: ${res.status} ${await res.text()}`);
    updated += payload.length;
    if (updated % 1024 === 0 || updated === rows.length) console.log(`embedded ${updated}/${rows.length}`);
  }
  console.log(`embeddings complete: ${updated} places`);
}
