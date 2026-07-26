import { readFile, writeFile, mkdir } from "node:fs/promises";
import type { PlaceRow } from "./types.js";

const DATA = new URL("../data/", import.meta.url).pathname;
// Bundled into the app: the entire pin directory ships offline, zero fetches.
const APP_ASSET = new URL("../../../apps/mobile/assets/data/", import.meta.url).pathname;

/**
 * Emit the compact pin dataset the map renders from.
 * Format: array of [slug, name, lat, lng, region] tuples (~1.2 MB for 12.6k).
 */
export async function pins(): Promise<void> {
  const rows: PlaceRow[] = JSON.parse(await readFile(DATA + "places.json", "utf8"));
  const tuples = rows.map((r) => [r.slug, r.name, r.lat, r.lng, r.region]);
  await mkdir(APP_ASSET, { recursive: true });
  const json = JSON.stringify(tuples);
  await writeFile(APP_ASSET + "pins.json", json);
  console.log(`pins: ${tuples.length} written to apps/mobile/assets/data/pins.json (${(json.length / 1e6).toFixed(2)} MB)`);
}
