import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OsmElement, PlaceRow } from "./types.js";
import { US_STATES } from "./extract.js";
import { readPlaces, writePlaces, withPlacesLock } from "./places-io.js";

/**
 * Par enrichment from per-hole OSM tags. data/raw-holes/*.json (fetched by
 * extractHoles) already carries golf=hole ways with tags.par + tags.ref; we
 * assign each to its nearest course (identical approach to holes.ts
 * enrichHoles) and, only when a course's hole set is unambiguous — numeric
 * refs covering exactly 1..N for N in {9,18,27,36}, every hole with a sane
 * par — sum the per-hole pars into attrs.par. For 27/36-hole facilities we
 * sum only the front 18 (ref 1-18), matching how "par" is quoted for a round.
 * Never overwrites an explicit attrs.par already on the row.
 */

const RAW_DIR = new URL("../data/raw-holes/", import.meta.url).pathname;

/** Max distance (m) from a hole to the course centroid it belongs to. */
const ASSIGN_RADIUS_M = 2_000;
const VALID_N = new Set([9, 18, 27, 36]);
const PAR_SUM_MIN = 27;
const PAR_SUM_MAX = 74;

interface Hole {
  ref: number | null;
  par: number | null;
  links: boolean;
}

export async function enrichPar(): Promise<void> {
  return withPlacesLock("enrich-par", () => enrichParUnlocked());
}

async function enrichParUnlocked(): Promise<void> {
  const rows: PlaceRow[] = await readPlaces();
  const byState = new Map<string, PlaceRow[]>();
  for (const r of rows) {
    if (!r.region) continue;
    (byState.get(r.region) ?? byState.set(r.region, []).get(r.region)!).push(r);
  }

  const holesByCourse = new Map<string, Hole[]>();
  let assigned = 0, orphans = 0;

  for (const state of US_STATES) {
    const places = byState.get(state);
    if (!places?.length) continue;
    let elements: OsmElement[];
    try {
      elements = JSON.parse(await readFile(join(RAW_DIR, `${state}.json`), "utf8")).elements;
    } catch {
      continue;
    }
    for (const el of elements) {
      if (el.tags?.golf !== "hole") continue;
      const lat = el.center?.lat ?? el.lat;
      const lon = el.center?.lon ?? el.lon;
      if (lat == null || lon == null) continue;
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
      // degrees -> meters (1 deg latitude ~= 111.32 km)
      if (!best || Math.sqrt(bestD2) * 111_320 > ASSIGN_RADIUS_M) {
        orphans++;
        continue;
      }
      const refNum = Number.parseInt(el.tags.ref ?? "", 10);
      const parNum = Number.parseInt(el.tags.par ?? "", 10);
      const hole: Hole = {
        ref: Number.isFinite(refNum) ? refNum : null,
        par: Number.isFinite(parNum) ? parNum : null,
        links: !!el.tags["golf:links"],
      };
      (holesByCourse.get(best.slug) ?? holesByCourse.set(best.slug, []).get(best.slug)!).push(hole);
      assigned++;
    }
  }

  const byN: Record<number, number> = { 9: 0, 18: 0, 27: 0, 36: 0 };
  let computed = 0, kept = 0, outliers = 0, alreadyExplicit = 0, links = 0, partialSkipped = 0, repaired = 0;

  for (const r of rows) {
    // golf:links turned out to be a sub-course grouping label in OSM, not a
    // links-style indicator (inland courses carry it) — never write it. This
    // runs for every row, not just rows with assigned holes, so a course
    // whose holes go unassigned on a later run can't keep a stale tag.
    if (r.attrs.setting?.includes("links")) {
      r.attrs.setting = r.attrs.setting.filter((s) => s !== "links");
      links++;
    }

    const holes = holesByCourse.get(r.slug);
    if (!holes?.length) continue;

    const n = holes.length;
    if (!VALID_N.has(n)) continue;
    const refs = holes.map((h) => h.ref);
    if (refs.some((ref) => ref == null)) continue;
    const refSet = new Set(refs as number[]);
    if (refSet.size !== n) continue; // duplicate refs -> ambiguous
    let complete = true;
    for (let i = 1; i <= n; i++) if (!refSet.has(i)) { complete = false; break; }
    if (!complete) continue;
    if (holes.some((h) => h.par == null || h.par < 3 || h.par > 6)) continue;

    byN[n] = (byN[n] ?? 0) + 1;
    const round = n >= 27 ? holes.filter((h) => (h.ref as number) <= 18) : holes;
    const sum = round.reduce((acc, h) => acc + (h.par as number), 0);
    computed++;

    // Guard: a "complete" 1..N ref set can still be a partial mapping of a
    // bigger course — e.g. only the front 9 of an 18-hole course surveyed.
    // Cross-check against the course's known hole count before treating the
    // sum as the course total.
    const known = r.attrs.holes ?? r.attrs.holesEst;
    const partial = (n === 9 && known != null && known >= 14) || (n === 18 && known != null && known >= 23);
    if (partial) {
      partialSkipped++;
      // Repair: if the stored par is exactly what this sum would produce, it
      // was almost certainly written by a prior (pre-fix) run of this same
      // computation — remove it so a re-run of enrich-par is enough to fix
      // already-cached rows, without touching a genuinely explicit par tag.
      if (r.attrs.par === sum) {
        delete r.attrs.par;
        repaired++;
      }
      continue;
    }

    if (sum < PAR_SUM_MIN || sum > PAR_SUM_MAX) {
      outliers++;
      continue;
    }
    if (r.attrs.par != null) {
      alreadyExplicit++;
      continue;
    }
    r.attrs.par = sum;
    kept++;
  }

  await writePlaces(rows);
  console.log(
    `par enrich: ${assigned} holes assigned (${orphans} orphans); complete sets by N: ` +
      `9=${byN[9]} 18=${byN[18]} 27=${byN[27]} 36=${byN[36]}`,
  );
  console.log(
    `par enrich: ${computed} courses had a computable sum, ${outliers} discarded as outliers ` +
      `(outside ${PAR_SUM_MIN}-${PAR_SUM_MAX}), ${alreadyExplicit} already had explicit par, ` +
      `${kept} newly written`,
  );
  console.log(
    `par enrich: ${partialSkipped} courses skipped as partial mappings (complete N-hole ref set but ` +
      `known hole count says the course is bigger), ${repaired} had a stale half-course par removed`,
  );
  console.log(`par enrich: ${links} courses tagged setting="links" from golf:links holes`);
}
