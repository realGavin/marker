import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import type { PlaceRow } from "./types.js";
import { readPlaces, writePlaces, withPlacesLock } from "./places-io.js";

/**
 * City backfill from the US Census Bureau's Gazetteer Places file (public
 * domain, no auth, one-time batch download — no metered API, no per-user
 * runtime cost, satisfies the "no reverse-geocoding service" constraint
 * because it's a static national list we fetch once and cache).
 *
 * For every place row with city == null, finds the nearest incorporated
 * place / CDP IN THE SAME STATE (r.region, a USPS code) from the gazetteer
 * and assigns its name as the course's city, flagging attrs.cityApprox =
 * true so provenance stays honest (this is a nearest-neighbor estimate, not
 * a stated fact). Matches beyond ACCEPT_RADIUS_KM are left null — genuinely
 * rural courses have no nearby incorporated place and should stay null
 * rather than get a guessed city.
 *
 * Source: 2023 Gazetteer primary, with 2024/2022 siblings as fallback in
 * case the Census restructures the directory layout; whichever resolves
 * first is used and printed. Downloaded once into data/geo/ (gitignored,
 * matches enrich-season.ts's NOAA cache) and reused on rerun.
 *
 * Idempotent/resumable: only rows with city == null are ever touched, and
 * an existing city is never overwritten, so a rerun (or a rerun after a
 * crash mid-run, before the single end-of-run writePlaces) just recomputes
 * the same result — no separate progress-state file is needed since the
 * whole pass is in-memory and finishes in well under a second once the
 * gazetteer is cached.
 */

const DATA = new URL("../data/", import.meta.url).pathname;
const GEO = DATA + "geo/";
const CACHE_FILE = GEO + "census-gaz-place-national.txt";

const GAZETTEER_URLS = [
  "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_place_national.zip",
  "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_place_national.zip",
  "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2022_Gazetteer/2022_Gaz_place_national.zip",
];
const USER_AGENT = "marker-etl/0.1 (golf place directory seeding; contact shuozeng21@gmail.com)";

const ACCEPT_RADIUS_KM = 25;

const R_EARTH_KM = 6_371;
function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Minimal single-entry ZIP reader (central-directory based, no deps) — the
 * Gazetteer archives are one .txt member, so we don't need a real zip lib.
 * Matches the project's existing no-dep pattern for archive formats (see
 * enrich-season.ts's hand-rolled tar reader).
 */
function unzipFirstEntry(buf: Buffer): Buffer {
  const EOCD_SIG = 0x06054b50;
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("not a valid zip (no end-of-central-directory record found)");
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  const CD_SIG = 0x02014b50;
  if (buf.readUInt32LE(cdOffset) !== CD_SIG) throw new Error("not a valid zip (bad central directory signature)");
  const method = buf.readUInt16LE(cdOffset + 10);
  const compSize = buf.readUInt32LE(cdOffset + 20);
  const localOffset = buf.readUInt32LE(cdOffset + 42);

  const LFH_SIG = 0x04034b50;
  if (buf.readUInt32LE(localOffset) !== LFH_SIG) throw new Error("not a valid zip (bad local file header signature)");
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLen + extraLen;
  const compData = buf.subarray(dataStart, dataStart + compSize);

  if (method === 0) return Buffer.from(compData);
  if (method === 8) return inflateRawSync(compData);
  throw new Error(`unsupported zip compression method ${method}`);
}

async function exists(f: string): Promise<boolean> {
  return access(f).then(
    () => true,
    () => false,
  );
}

/** Downloads (trying each URL in order) and caches the gazetteer text; reuses the cache on rerun. */
async function loadGazetteerText(): Promise<string> {
  await mkdir(GEO, { recursive: true });
  if (await exists(CACHE_FILE)) {
    console.log(`enrich-city: using cached gazetteer at ${CACHE_FILE}`);
    return readFile(CACHE_FILE, "utf8");
  }

  let lastErr: unknown;
  for (const url of GAZETTEER_URLS) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
      if (!res.ok) {
        lastErr = new Error(`${url} -> HTTP ${res.status}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const text = unzipFirstEntry(buf).toString("utf8");
      await writeFile(CACHE_FILE, text, "utf8");
      console.log(`enrich-city: source used -> ${url}`);
      return text;
    } catch (e) {
      lastErr = e;
      console.log(`enrich-city: ${url} failed (${(e as Error).message ?? e}), trying next candidate`);
    }
  }
  throw new Error(
    `enrich-city: could not fetch any Census Gazetteer source (tried ${GAZETTEER_URLS.length} URLs); ` +
      `last error: ${String(lastErr)}. No bundled OSM fallback is present — populate ${CACHE_FILE} manually to proceed offline.`,
  );
}

interface GazPlace {
  name: string;
  lat: number;
  lng: number;
}

// Census appends the LSAD ("legal/statistical area description") in
// lowercase after the proper name — e.g. "Norco city", "Arizona City CDP",
// "Rapid City city" — while the proper name itself is Title Case. That case
// distinction is what lets us safely strip only the trailing type word:
// "Carson City" (no LSAD suffix in the gazetteer; a real proper name ending
// in "City") is left untouched, while "Rapid City city" -> "Rapid City".
// "city and borough" is a compound LSAD used only by Alaska's three unified
// city-boroughs (Juneau, Sitka, Wrangell) — it must be listed as one
// alternative (not left to the single-word "borough" branch) or it strips
// to a dangling "Sitka city and" instead of "Sitka".
const TYPE_SUFFIX =
  /\s+(city and borough|city|town|village|CDP|borough|township|municipality|corporation|government)$/;
function stripTypeSuffix(rawName: string): string {
  return rawName.replace(TYPE_SUFFIX, "").trim();
}

function parseGazetteer(text: string): Map<string, GazPlace[]> {
  const byState = new Map<string, GazPlace[]>();
  const lines = text.split("\n");
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const cols = line.split("\t");
    if (cols.length < 12) continue;
    const usps = cols[0]?.trim();
    const rawName = cols[3]?.trim();
    const lat = Number.parseFloat(cols[10] ?? "");
    const lng = Number.parseFloat(cols[11] ?? "");
    if (!usps || !rawName || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const name = stripTypeSuffix(rawName);
    if (!name) continue;
    let arr = byState.get(usps);
    if (!arr) {
      arr = [];
      byState.set(usps, arr);
    }
    arr.push({ name, lat, lng });
  }
  return byState;
}

function nearestPlace(lat: number, lng: number, candidates: GazPlace[]): { place: GazPlace; distKm: number } | null {
  let best: GazPlace | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = haversineKm(lat, lng, c.lat, c.lng);
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best ? { place: best, distKm: bestDist } : null;
}

/**
 * Consolidated city-boroughs whose Gazetteer centroid is useless: the point is
 * the geometric middle of a county-sized polygon (Anchorage spans ~1,700 sq mi
 * of mountain and wilderness), so it lands tens of km from the built-up core
 * and a tiny neighbouring CDP wins the nearest-neighbour test. Courses inside
 * a box below take the municipality's name instead. Boxes are drawn around the
 * developed area, not the legal boundary.
 */
const CONSOLIDATED_BOXES = [
  { name: "Anchorage", minLat: 61.05, maxLat: 61.35, minLng: -150.1, maxLng: -149.5 },
];

function containingConsolidated(lat: number, lng: number): string | null {
  for (const b of CONSOLIDATED_BOXES) {
    if (lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng) return b.name;
  }
  return null;
}

function percentile(sortedAsc: number[], p: number): number {
  if (!sortedAsc.length) return NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length));
  return sortedAsc[idx]!;
}

export async function enrichCity(): Promise<void> {
  return withPlacesLock("enrich-city", enrichCityUnlocked);
}

async function enrichCityUnlocked(): Promise<void> {
  const rows: PlaceRow[] = await readPlaces();
  const before = rows.filter((r) => r.city != null).length;
  console.log(
    `enrich-city: coverage before: ${before}/${rows.length} (${((before / rows.length) * 100).toFixed(1)}%)`,
  );

  const text = await loadGazetteerText();
  const byState = parseGazetteer(text);
  const totalPlaces = [...byState.values()].reduce((a, v) => a + v.length, 0);
  console.log(`enrich-city: parsed ${totalPlaces} gazetteer places across ${byState.size} states`);

  const dists: number[] = [];
  let backfilled = 0;
  let skippedNoState = 0;
  let skippedTooFar = 0;
  for (const r of rows) {
    if (r.city != null) continue; // never overwrite an existing city
    const candidates = r.region ? byState.get(r.region) : undefined;
    if (!candidates || !candidates.length) {
      skippedNoState++;
      continue;
    }
    const consolidated = containingConsolidated(r.lat, r.lng);
    const match = consolidated ? null : nearestPlace(r.lat, r.lng, candidates);
    if (!consolidated && !match) {
      skippedNoState++;
      continue;
    }
    if (match && match.distKm > ACCEPT_RADIUS_KM) {
      skippedTooFar++;
      continue;
    }
    r.city = consolidated ?? match!.place.name;
    r.attrs.cityApprox = true;
    if (match) dists.push(match.distKm);
    backfilled++;
  }

  await writePlaces(rows);

  const after = rows.filter((r) => r.city != null).length;
  dists.sort((a, b) => a - b);
  const median = percentile(dists, 0.5);
  const p90 = percentile(dists, 0.9);

  console.log(
    `enrich-city: backfilled ${backfilled} rows ` +
      `(skipped ${skippedTooFar} beyond ${ACCEPT_RADIUS_KM}km, ${skippedNoState} with no gazetteer match for their state)`,
  );
  console.log(
    `enrich-city: distance distribution of accepted matches — median ${median.toFixed(2)}km, p90 ${p90.toFixed(2)}km`,
  );
  console.log(
    `enrich-city: coverage after: ${after}/${rows.length} (${((after / rows.length) * 100).toFixed(1)}%)`,
  );
}
