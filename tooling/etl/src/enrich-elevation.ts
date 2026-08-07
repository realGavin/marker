import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OsmElement, PlaceRow } from "./types.js";
import { US_STATES } from "./extract.js";
import { readPlaces, writePlaces, withPlacesLock } from "./places-io.js";

/**
 * Elevation-range enrichment via USGS EPQS (Elevation Point Query Service),
 * public domain, no key required: https://epqs.nationalmap.gov/v1/json.
 * Samples up to 10 hole centers (spread across the course, from
 * data/raw-holes) plus the course centroid; falls back to centroid +/-
 * offsets when no holes are mapped. attrs.elevRangeM = round(max-min) of the
 * successfully-fetched sample points.
 *
 * Resumable: data/elevation-state.json maps slug -> {range, centroid}
 * (centroid = the course-centroid sample, kept separately so enrich-setting's
 * "centroid elevation > 1500m" mountain rule doesn't need a second fetch),
 * and already-present slugs are skipped on rerun, so partial batches are
 * safe to resume.
 */

const EPQS = "https://epqs.nationalmap.gov/v1/json";
const RAW_DIR = new URL("../data/raw-holes/", import.meta.url).pathname;
const DATA = new URL("../data/", import.meta.url).pathname;
const STATE_FILE = DATA + "elevation-state.json";

const ASSIGN_RADIUS_M = 2_000;
const CONCURRENCY = 5;
const MAX_HOLES = 10;
const OFFSET_M = 400; // ~400m N/E/S/W pad when a course has no mapped holes

interface ElevEntry {
  range: number;
  centroid: number;
}

async function readState(): Promise<Record<string, ElevEntry>> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

/** Nearest-course hole-center assignment, identical approach to holes.ts. */
async function holeCentersByCourse(rows: PlaceRow[]): Promise<Map<string, { lat: number; lon: number; ref: number | null }[]>> {
  const byState = new Map<string, PlaceRow[]>();
  for (const r of rows) {
    if (!r.region) continue;
    (byState.get(r.region) ?? byState.set(r.region, []).get(r.region)!).push(r);
  }
  const out = new Map<string, { lat: number; lon: number; ref: number | null }[]>();
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
      if (!best || Math.sqrt(bestD2) * 111_320 > ASSIGN_RADIUS_M) continue;
      const refNum = Number.parseInt(el.tags.ref ?? "", 10);
      (out.get(best.slug) ?? out.set(best.slug, []).get(best.slug)!).push({
        lat,
        lon,
        ref: Number.isFinite(refNum) ? refNum : null,
      });
    }
  }
  return out;
}

function samplePoints(r: PlaceRow, holes: { lat: number; lon: number; ref: number | null }[] | undefined): { lat: number; lon: number }[] {
  const points: { lat: number; lon: number }[] = [{ lat: r.lat, lon: r.lng }];
  if (holes?.length) {
    const sorted = [...holes].sort((a, b) => (a.ref ?? 999) - (b.ref ?? 999));
    // ceil (not floor) so the stride spreads up to MAX_HOLES samples across
    // the WHOLE sorted list — floor(n/MAX_HOLES) rounds down to a stride of
    // 1 for any n < 2*MAX_HOLES, which (combined with the points.length cap
    // below) sampled only the front half of the course for e.g. n=18.
    const step = Math.max(1, Math.ceil(sorted.length / MAX_HOLES));
    for (let i = 0; i < sorted.length && points.length < MAX_HOLES + 1; i += step) {
      points.push({ lat: sorted[i]!.lat, lon: sorted[i]!.lon });
    }
  }
  if (points.length < 3) {
    // No (or too few) mapped holes: pad with N/S offsets around the centroid.
    const dLat = OFFSET_M / 111_320;
    points.push({ lat: r.lat + dLat, lon: r.lng }, { lat: r.lat - dLat, lon: r.lng });
  }
  return points;
}

function parseElevation(value: unknown): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(n)) return null;
  // Sanity: below Death Valley (-86m) to above Denali (6190m), generous pad both ways.
  if (n < -150 || n > 6500) return null;
  return n;
}

async function fetchElevation(lat: number, lon: number): Promise<number | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${EPQS}?x=${lon}&y=${lat}&units=Meters`, {
        headers: { "User-Agent": "marker-etl/0.1 (golf place directory seeding; contact shuozeng21@gmail.com)" },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) {
        // The service occasionally returns a plain-text error body with a
        // 200 status (e.g. "Call failed...") for points with no coverage
        // (ocean, etc) — treat any non-JSON body as "no data" for that point.
        let json: { value?: unknown } | null = null;
        try {
          json = (await res.json()) as { value?: unknown };
        } catch {
          return null;
        }
        return parseElevation(json?.value);
      }
    } catch {
      // fall through to backoff
    }
    await new Promise((r) => setTimeout(r, 1_500 * (attempt + 1)));
  }
  return null;
}

export async function enrichElevation(limit?: number): Promise<void> {
  return withPlacesLock("enrich-elevation", () => enrichElevationUnlocked(limit));
}

async function enrichElevationUnlocked(limit?: number): Promise<void> {
  const rows: PlaceRow[] = await readPlaces();
  const state = await readState();
  const holeMap = await holeCentersByCourse(rows);

  const todo = rows.filter((r) => !(r.slug in state)).slice(0, limit ?? Infinity);
  console.log(`elevation: ${rows.length} places, ${Object.keys(state).length} done, ${todo.length} to process`);

  let ok = 0, fail = 0, i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const row = todo[i++];
      if (!row) break;
      const points = samplePoints(row, holeMap.get(row.slug)); // points[0] is always the centroid
      const elevs: number[] = [];
      let centroidElev: number | null = null;
      for (let pi = 0; pi < points.length; pi++) {
        const e = await fetchElevation(points[pi]!.lat, points[pi]!.lon);
        if (e != null) {
          elevs.push(e);
          if (pi === 0) centroidElev = e;
        }
      }
      // Publish only when at least 4 of the (up to 11) sample points
      // resolved — 2 was too permissive (e.g. just the centroid + one hole),
      // giving a "range" that isn't a meaningful spread across the course.
      if (elevs.length >= 4 && centroidElev != null) {
        state[row.slug] = { range: Math.round(Math.max(...elevs) - Math.min(...elevs)), centroid: Math.round(centroidElev) };
        ok++;
      } else {
        fail++;
      }
      const n = ok + fail;
      if (n % 200 === 0) {
        console.log(`elevation: ${n}/${todo.length} (ok ${ok}, fail ${fail})`);
        // flush periodically so a killed long batch doesn't lose progress
        await writeFile(STATE_FILE, JSON.stringify(state));
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  await writeFile(STATE_FILE, JSON.stringify(state));
  for (const r of rows) {
    const entry = state[r.slug];
    if (entry != null) r.attrs.elevRangeM = entry.range;
  }
  await writePlaces(rows);
  console.log(`elevation done: ok ${ok}, fail ${fail} (rerun to retry the rest — state file skips done slugs)`);
  console.log(`elevation: ${Object.keys(state).length}/${rows.length} places now have elevRangeM`);
}

const SPARSE_AFFECTED_FILE = DATA + "elevation-sparse-affected.json";
/** Old, front-half-biased stride was in effect for any course with this many assigned holes. */
const SPARSE_MIN_HOLES = 12;

/**
 * `--redo-sparse`: every slug currently in elevation-state.json was sampled
 * under the pre-fix, front-half-biased stride (see samplePoints above). That
 * bias only mattered for courses with enough mapped holes that the old
 * floor()-based stride under-sampled the back half — courses with fewer
 * assigned holes than that got full coverage even under the old code, so
 * they don't need a re-sample.
 *
 * This is local-only (state file + already-cached raw-holes, no network) and
 * cheap, unlike a full elevation re-run (hours of USGS EPQS fetches). It
 * identifies the affected slugs, removes them from elevation-state.json so a
 * plain `enrich-elevation` run treats them as "todo" again, and prints the
 * count. It does NOT itself re-fetch — that's the (now much smaller) re-run
 * left for the architect.
 */
export async function markSparseElevation(): Promise<void> {
  const rows: PlaceRow[] = await readPlaces();
  const state = await readState();
  const holeMap = await holeCentersByCourse(rows);

  const affected: string[] = [];
  for (const slug of Object.keys(state)) {
    const n = holeMap.get(slug)?.length ?? 0;
    if (n >= SPARSE_MIN_HOLES) affected.push(slug);
  }

  for (const slug of affected) delete state[slug];
  await writeFile(STATE_FILE, JSON.stringify(state));
  await writeFile(SPARSE_AFFECTED_FILE, JSON.stringify(affected));

  console.log(
    `elevation --redo-sparse: ${affected.length} courses were sampled under the old front-half-biased ` +
      `stride and have >=${SPARSE_MIN_HOLES} assigned holes (the affected class)`,
  );
  console.log(
    `elevation --redo-sparse: removed those ${affected.length} slugs from elevation-state.json ` +
      `(list also written to data/elevation-sparse-affected.json); ${Object.keys(state).length} slugs remain done`,
  );
  console.log(
    "elevation --redo-sparse: re-run command for the architect: " +
      "cd tooling/etl && corepack pnpm etl enrich-elevation " +
      `(now only reprocesses the ${affected.length} marked slugs, not the full ${rows.length}-course batch)`,
  );
}
