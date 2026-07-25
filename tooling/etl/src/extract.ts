import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import type { OsmElement } from "./types.js";

export const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC",
];

const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

// OSM services require a descriptive User-Agent (they 406 anonymous clients).
const USER_AGENT = "marker-etl/0.1 (golf place directory seeding; contact shuozeng21@gmail.com)";

const RAW_DIR = new URL("../data/raw/", import.meta.url).pathname;

function query(state: string): string {
  return `[out:json][timeout:180];
area["ISO3166-2"="US-${state}"][admin_level=4]->.a;
nwr["leisure"="golf_course"](area.a);
out center tags;`;
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

/** Extract all states, caching raw responses; idempotent (skips cached). */
export async function extractAll(force = false): Promise<void> {
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
        console.log(`${state}: ${elements.length} elements (${++done}/${US_STATES.length})`);
        break;
      } catch (e) {
        attempt++;
        if (attempt >= 10) throw new Error(`${state}: giving up after ${attempt} attempts: ${e}`);
        // 429/504 = server busy: wait substantially longer before hitting the next mirror
        const busy = /429|504|timeout/i.test(String(e));
        const backoff = Math.min(180_000, (busy ? 30_000 : 8_000) * attempt);
        console.log(`${state}: retry ${attempt} in ${backoff / 1000}s (${e})`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    // be a polite Overpass citizen
    await new Promise((r) => setTimeout(r, 3_000));
  }
  console.log("extract complete");
}

export async function readRaw(): Promise<Map<string, OsmElement[]>> {
  const out = new Map<string, OsmElement[]>();
  for (const state of US_STATES) {
    const file = join(RAW_DIR, `${state}.json`);
    try {
      const { elements } = JSON.parse(await readFile(file, "utf8"));
      out.set(state, elements);
    } catch {
      /* not extracted yet */
    }
  }
  return out;
}
