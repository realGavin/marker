import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import type { OsmElement, PlaceRow } from "./types.js";
import { US_STATES } from "./extract.js";

/**
 * Hole-count enrichment. Course polygons rarely carry a holes= tag, but many
 * courses have their individual holes/greens mapped as separate OSM ways.
 * We extract those per state, assign each to the nearest course centroid, and
 * derive an estimated hole count (max of hole-ways and green-ways) used for
 * map filter tags. Displayed facts keep only explicit holes= tags — the
 * estimate drives discovery chips, never a stated fact.
 */

const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const USER_AGENT = "marker-etl/0.1 (golf place directory seeding; contact shuozeng21@gmail.com)";
const RAW_DIR = new URL("../data/raw-holes/", import.meta.url).pathname;
const DATA = new URL("../data/", import.meta.url).pathname;

/** Max distance (m) from a hole/green to the course centroid it belongs to. */
const ASSIGN_RADIUS_M = 2_000;

function query(state: string): string {
  return `[out:json][timeout:180];
area["ISO3166-2"="US-${state}"][admin_level=4]->.a;
(way["golf"="hole"](area.a);way["golf"="green"](area.a);)->.g;
.g out center tags;`;
}

async function fetchState(state: string, mirrorIdx = 0): Promise<OsmElement[]> {
  const url = MIRRORS[mirrorIdx % MIRRORS.length]!;
  const res = await fetch(url, {
    method: "POST",
    body: "data=" + encodeURIComponent(query(state)),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(240_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const json = (await res.json()) as { elements: OsmElement[]; remark?: string };
  if (json.remark && /error|timed out/i.test(json.remark)) throw new Error(`remark: ${json.remark}`);
  return json.elements;
}

export async function extractHoles(force = false): Promise<void> {
  await mkdir(RAW_DIR, { recursive: true });
  let done = 0;
  for (const state of US_STATES) {
    const file = join(RAW_DIR, `${state}.json`);
    const cached = await access(file).then(() => true, () => false);
    if (cached && !force) {
      done++;
      continue;
    }
    let attempt = 0;
    for (;;) {
      try {
        const elements = await fetchState(state, attempt);
        await writeFile(file, JSON.stringify({ state, fetchedAt: new Date().toISOString(), elements }));
        console.log(`${state}: ${elements.length} hole/green ways (${++done}/${US_STATES.length})`);
        break;
      } catch (e) {
        attempt++;
        if (attempt >= 10) throw new Error(`${state}: giving up after ${attempt} attempts: ${e}`);
        const busy = /429|504|timeout/i.test(String(e));
        const backoff = Math.min(180_000, (busy ? 30_000 : 8_000) * attempt);
        console.log(`${state}: retry ${attempt} in ${backoff / 1000}s (${e})`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  console.log("holes extract complete");
}

/**
 * Assign hole/green ways to the nearest course within ASSIGN_RADIUS_M and
 * write attrs.holesEst into places.json. Rerun-safe: recomputes from scratch.
 */
export async function enrichHoles(): Promise<void> {
  const rows: (PlaceRow & { attrs: PlaceRow["attrs"] & { holesEst?: number } })[] = JSON.parse(
    await readFile(DATA + "places.json", "utf8"),
  );
  const byState = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!r.region) continue;
    const list = byState.get(r.region) ?? [];
    list.push(r);
    byState.set(r.region, list);
  }

  let assigned = 0, orphans = 0;
  const counts = new Map<string, { holes: number; greens: number }>();
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
      const lat = el.center?.lat ?? el.lat;
      const lon = el.center?.lon ?? el.lon;
      if (lat == null || lon == null) continue;
      const cosLat = Math.cos((lat * Math.PI) / 180);
      let best: (typeof places)[number] | null = null;
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
      const c = counts.get(best.slug) ?? { holes: 0, greens: 0 };
      if (el.tags?.golf === "hole") c.holes++;
      else c.greens++;
      counts.set(best.slug, c);
      assigned++;
    }
  }

  let est = 0;
  for (const r of rows) {
    const c = counts.get(r.slug);
    delete r.attrs.holesEst;
    if (!c) continue;
    const n = Math.max(c.holes, c.greens);
    if (n >= 4) {
      r.attrs.holesEst = n;
      est++;
    }
  }
  await writeFile(DATA + "places.json", JSON.stringify(rows));
  console.log(
    `holes enrich: ${assigned} ways assigned (${orphans} orphans), ${est}/${rows.length} places got holesEst`,
  );
}
