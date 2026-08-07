import { readFile, writeFile, mkdir } from "node:fs/promises";
import type { PlaceRow } from "./types.js";

const DATA = new URL("../data/", import.meta.url).pathname;
// Bundled into the app: the entire pin directory ships offline, zero fetches.
const APP_ASSET = new URL("../../../apps/mobile/assets/data/", import.meta.url).pathname;

/**
 * Filter tags matching the golf skin's pinFilters keys. Explicit OSM tags win;
 * holesEst (counted mapped holes/greens) and name signals fill the gaps.
 * These drive discovery chips only — displayed facts stay strictly tag-sourced.
 */
function tags(r: PlaceRow): string[] {
  const t: string[] = [];
  const holes = r.attrs.holes ?? r.attrs.holesEst;
  if (holes != null) {
    if (holes >= 14) t.push("18");
    else if (holes >= 4) t.push("9");
  }
  // Complementary access tags: "private" = explicit tag or Country Club name;
  // "public" = everything else (most US courses are public; explicit public
  // tagging is ~2.5%, so absence-of-private-signal is the honest proxy).
  const name = r.name.toLowerCase();
  const isPrivate = r.attrs.access === "private" || /\bcountry club\b/.test(name);
  t.push(isPrivate ? "private" : "public");

  // Course Intelligence Pack signals (enrich-elevation/-wind/-setting/-length) —
  // emitted verbatim/derived when present, omitted otherwise (partial coverage
  // while those streams are still batching is expected and fine).
  for (const s of r.attrs.setting ?? []) t.push(s);
  if (r.attrs.windMs != null && r.attrs.windMs > 6) t.push("windy");
  if (r.attrs.elevRangeM != null && r.attrs.elevRangeM > 40) t.push("hilly");
  if (r.attrs.lengthYds != null) {
    if (r.attrs.lengthYds < 5800) t.push("short");
    else if (r.attrs.lengthYds > 6800) t.push("long");
  }
  return t;
}

/**
 * Emit the compact pin dataset the map renders from.
 * Format: [slug, name, lat, lng, region, tags, city] tuples (~1.4 MB for 12.6k).
 */
export async function pins(): Promise<void> {
  const rows: PlaceRow[] = JSON.parse(await readFile(DATA + "places.json", "utf8"));
  const tuples = rows.map((r) => [r.slug, r.name, r.lat, r.lng, r.region, tags(r), r.city]);
  await mkdir(APP_ASSET, { recursive: true });
  const json = JSON.stringify(tuples);
  await writeFile(APP_ASSET + "pins.json", json);
  console.log(`pins: ${tuples.length} written to apps/mobile/assets/data/pins.json (${(json.length / 1e6).toFixed(2)} MB)`);
}
