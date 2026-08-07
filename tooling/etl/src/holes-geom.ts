import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import type { OsmElement } from "./types.js";
import { US_STATES } from "./extract.js";

/**
 * Per-hole line geometry, for length enrichment. Same per-state Overpass
 * loop as holes.ts, but `out geom;` (full node coordinates) instead of
 * `out center tags;`, and golf=hole only — greens carry no useful length
 * signal and would double the payload for nothing.
 */

const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const USER_AGENT = "marker-etl/0.1 (golf place directory seeding; contact shuozeng21@gmail.com)";
const RAW_DIR = new URL("../data/raw-holes-geom/", import.meta.url).pathname;

function query(state: string): string {
  return `[out:json][timeout:180];
area["ISO3166-2"="US-${state}"][admin_level=4]->.a;
way["golf"="hole"](area.a);
out geom;`;
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

/**
 * Extract hole geometry per state, caching to data/raw-holes-geom/. Resumable
 * (skips cached states unless --force). Pass `only` to fetch a single state
 * — used for smoke-testing before the architect kicks off the full 51-state run.
 */
export async function extractHolesGeom(force = false, only?: string): Promise<void> {
  await mkdir(RAW_DIR, { recursive: true });
  const states = only ? [only.toUpperCase()] : US_STATES;
  let done = 0;
  for (const state of states) {
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
        console.log(`${state}: ${elements.length} hole ways w/ geometry (${++done}/${states.length})`);
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
  console.log("holes-geom extract complete");
}
