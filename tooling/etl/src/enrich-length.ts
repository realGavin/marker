import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { OsmElement, PlaceRow } from "./types.js";

/**
 * Yardage enrichment from per-hole line geometry (data/raw-holes-geom, from
 * extract-holes-geom). Same nearest-course assignment radius as holes.ts /
 * enrich-par.ts. A course's length is only published when its hole set is
 * "complete" by the same rule enrich-par.ts uses (numeric refs covering
 * exactly 1..N, N in {9,18,27,36}) — an incomplete set would understate
 * yardage, which is worse than omitting it. Only states present in the
 * geometry cache are processed; rerun after extract-holes-geom fetches more.
 */

const RAW_DIR = new URL("../data/raw-holes-geom/", import.meta.url).pathname;
const DATA = new URL("../data/", import.meta.url).pathname;

const ASSIGN_RADIUS_M = 2_000;
const VALID_N = new Set([9, 18, 27, 36]);
const METERS_TO_YARDS = 1.09361;
// Sanity clamp: publish only plausible totals.
const CLAMP_18 = [1500, 8500] as const;
const CLAMP_9 = [800, 4000] as const;

const R_EARTH_M = 6_371_000;
function haversineM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

interface Hole {
  ref: number | null;
  lengthM: number;
}

export async function enrichLength(): Promise<void> {
  const rows: PlaceRow[] = JSON.parse(await readFile(DATA + "places.json", "utf8"));
  const byState = new Map<string, PlaceRow[]>();
  for (const r of rows) {
    if (!r.region) continue;
    (byState.get(r.region) ?? byState.set(r.region, []).get(r.region)!).push(r);
  }

  let cachedStates: string[];
  try {
    cachedStates = (await readdir(RAW_DIR)).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""));
  } catch {
    console.log("enrich-length: no data/raw-holes-geom cache yet — run extract-holes-geom first");
    return;
  }

  const holesByCourse = new Map<string, Hole[]>();
  let assigned = 0, orphans = 0;

  for (const state of cachedStates) {
    const places = byState.get(state);
    if (!places?.length) continue;
    const { elements } = JSON.parse(await readFile(join(RAW_DIR, `${state}.json`), "utf8")) as { elements: OsmElement[] };
    for (const el of elements) {
      const geom = el.geometry;
      if (!geom?.length) continue;
      // centroid = average of the line's nodes (no separate `center` field with `out geom;`)
      const lat = geom.reduce((s, p) => s + p.lat, 0) / geom.length;
      const lon = geom.reduce((s, p) => s + p.lon, 0) / geom.length;
      const cosLat = Math.cos((lat * Math.PI) / 180);
      let best: PlaceRow | null = null;
      let bestD2 = Infinity;
      for (const p of places) {
        const d2 = (p.lat - lat) ** 2 + ((p.lng - lon) * cosLat) ** 2;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = p;
        }
      }
      if (!best || Math.sqrt(bestD2) * 111_320 > ASSIGN_RADIUS_M) {
        orphans++;
        continue;
      }
      let lengthM = 0;
      for (let i = 1; i < geom.length; i++) lengthM += haversineM(geom[i - 1]!, geom[i]!);
      const refNum = Number.parseInt(el.tags?.ref ?? "", 10);
      (holesByCourse.get(best.slug) ?? holesByCourse.set(best.slug, []).get(best.slug)!).push({
        ref: Number.isFinite(refNum) ? refNum : null,
        lengthM,
      });
      assigned++;
    }
  }

  let computed = 0, outliers = 0, written = 0;
  for (const r of rows) {
    const holes = holesByCourse.get(r.slug);
    if (!holes?.length) continue;
    const n = holes.length;
    if (!VALID_N.has(n)) continue;
    const refs = holes.map((h) => h.ref);
    if (refs.some((ref) => ref == null)) continue;
    const refSet = new Set(refs as number[]);
    if (refSet.size !== n) continue;
    let complete = true;
    for (let i = 1; i <= n; i++) if (!refSet.has(i)) { complete = false; break; }
    if (!complete) continue;

    const round = n >= 27 ? holes.filter((h) => (h.ref as number) <= 18) : holes;
    const totalM = round.reduce((acc, h) => acc + h.lengthM, 0);
    const yds = Math.round((totalM * METERS_TO_YARDS) / 10) * 10;
    computed++;

    const clamp = round.length >= 14 ? CLAMP_18 : CLAMP_9;
    if (yds < clamp[0] || yds > clamp[1]) {
      outliers++;
      continue;
    }
    r.attrs.lengthYds = yds;
    r.attrs.lengthEst = true;
    written++;
  }

  await writeFile(DATA + "places.json", JSON.stringify(rows));
  console.log(
    `length enrich: states cached ${cachedStates.length}/51, ${assigned} hole ways assigned (${orphans} orphans)`,
  );
  console.log(
    `length enrich: ${computed} courses had a computable total, ${outliers} discarded as outliers, ${written} lengthYds written`,
  );
}
