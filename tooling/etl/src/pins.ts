import { readFile, writeFile, mkdir } from "node:fs/promises";
import type { PlaceRow } from "./types.js";

const DATA = new URL("../data/", import.meta.url).pathname;
// Bundled into the app: the entire pin directory ships offline, zero fetches.
const APP_ASSET = new URL("../../../apps/mobile/assets/data/", import.meta.url).pathname;

/** Filter tags matching the golf skin's pinFilters keys. */
function tags(r: PlaceRow): string[] {
  const t: string[] = [];
  if (r.attrs.holes != null) {
    if (r.attrs.holes >= 18) t.push("18");
    else if (r.attrs.holes <= 9) t.push("9");
  }
  if (r.attrs.access === "public" || r.attrs.access === "municipal") t.push("public");
  return t;
}

/**
 * Emit the compact pin dataset the map renders from.
 * Format: array of [slug, name, lat, lng, region, tags] tuples (~1.3 MB for 12.6k).
 */
export async function pins(): Promise<void> {
  const rows: PlaceRow[] = JSON.parse(await readFile(DATA + "places.json", "utf8"));
  const tuples = rows.map((r) => [r.slug, r.name, r.lat, r.lng, r.region, tags(r)]);
  await mkdir(APP_ASSET, { recursive: true });
  const json = JSON.stringify(tuples);
  await writeFile(APP_ASSET + "pins.json", json);
  console.log(`pins: ${tuples.length} written to apps/mobile/assets/data/pins.json (${(json.length / 1e6).toFixed(2)} MB)`);
}
