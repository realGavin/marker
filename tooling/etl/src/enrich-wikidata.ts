import { readFile, writeFile, access } from "node:fs/promises";
import type { PlaceRow } from "./types.js";
import { slugify } from "./transform.js";

/**
 * Designer + year-opened enrichment from Wikidata (free, no key; SPARQL
 * endpoint asks for a descriptive User-Agent same as OSM does). Query: all
 * items instance-of golf course (Q1048525) in the US (P17=Q30) with
 * coordinates (P625), pulling architect (P84, falling back to P287 "designed
 * by") and inception (P571) where present. Cached raw to data/geo/wikidata.json
 * (idempotent — skips the fetch if already cached).
 *
 * NB: GROUP_CONCAT + UNION inside one OPTIONAL blew Wikidata's Blazegraph
 * query planner (StackOverflowError). Two independent OPTIONALs for P84/P287
 * dodge that; the (item, architect) fan-out is collapsed back down client-side.
 *
 * Matching to places.json: normalized-name token overlap >=0.6 (same
 * threshold as report.ts's ground-truth matcher) AND haversine <2km,
 * closest wins among qualifying candidates. Only fills attrs.designer /
 * attrs.yearOpened where currently absent.
 */

const DATA = new URL("../data/", import.meta.url).pathname;
const CACHE_FILE = DATA + "geo/wikidata.json";
const USER_AGENT = "marker-etl/0.1 (golf place directory seeding; contact shuozeng21@gmail.com)";
const MATCH_RADIUS_M = 2_000;
const TOKEN_OVERLAP_MIN = 0.6;

const QUERY = `SELECT ?item ?itemLabel ?coord ?p84Label ?p287Label ?inception WHERE {
  ?item wdt:P31 wd:Q1048525 .
  ?item wdt:P17 wd:Q30 .
  ?item wdt:P625 ?coord .
  ?item rdfs:label ?itemLabel . FILTER(lang(?itemLabel)="en")
  OPTIONAL { ?item wdt:P571 ?inception }
  OPTIONAL {
    ?item wdt:P84 ?p84 .
    ?p84 rdfs:label ?p84Label . FILTER(lang(?p84Label)="en")
  }
  OPTIONAL {
    ?item wdt:P287 ?p287 .
    ?p287 rdfs:label ?p287Label . FILTER(lang(?p287Label)="en")
  }
}`;

interface Binding {
  item: { value: string };
  itemLabel: { value: string };
  coord: { value: string }; // "Point(lon lat)"
  p84Label?: { value: string };
  p287Label?: { value: string };
  inception?: { value: string };
}

interface WikidataCourse {
  qid: string;
  name: string;
  lat: number;
  lon: number;
  architects: string[];
  year: number | null;
}

async function exists(f: string): Promise<boolean> {
  return access(f).then(() => true, () => false);
}

async function fetchWikidata(): Promise<Binding[]> {
  if (await exists(CACHE_FILE)) {
    return JSON.parse(await readFile(CACHE_FILE, "utf8"));
  }
  const res = await fetch("https://query.wikidata.org/sparql", {
    method: "POST",
    body: "query=" + encodeURIComponent(QUERY),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/sparql-results+json",
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`wikidata query failed: HTTP ${res.status}`);
  const json = (await res.json()) as { results: { bindings: Binding[] } };
  const bindings = json.results.bindings;
  await writeFile(CACHE_FILE, JSON.stringify(bindings));
  return bindings;
}

function groupByItem(bindings: Binding[]): WikidataCourse[] {
  const byQid = new Map<string, WikidataCourse>();
  for (const b of bindings) {
    const qid = b.item.value.split("/").pop()!;
    const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(b.coord.value);
    if (!m) continue;
    const lon = Number.parseFloat(m[1]!), lat = Number.parseFloat(m[2]!);
    let c = byQid.get(qid);
    if (!c) {
      c = { qid, name: b.itemLabel.value, lat, lon, architects: [], year: null };
      byQid.set(qid, c);
    }
    const label = b.p84Label?.value ?? b.p287Label?.value;
    if (label && !c.architects.includes(label)) c.architects.push(label);
    if (b.inception?.value) {
      const y = Number.parseInt(b.inception.value.slice(0, 4), 10);
      if (Number.isFinite(y) && (c.year == null || y < c.year)) c.year = y;
    }
  }
  return [...byQid.values()];
}

const STOPWORDS = new Set(["golf", "course", "club", "country", "the", "links", "at", "park"]);
const tokens = (s: string) => new Set(slugify(s).split("-").filter((t) => t && !STOPWORDS.has(t)));

function tokenOverlap(a: string, b: string): number {
  const ta = tokens(a);
  if (ta.size === 0) return slugify(a) === slugify(b) ? 1 : 0;
  const tb = tokens(b);
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit / ta.size;
}

export async function enrichWikidata(): Promise<void> {
  const bindings = await fetchWikidata();
  const wdCourses = groupByItem(bindings);
  console.log(`enrich-wikidata: ${bindings.length} raw bindings -> ${wdCourses.length} distinct US golf courses`);

  const rows: PlaceRow[] = JSON.parse(await readFile(DATA + "places.json", "utf8"));

  let matched = 0, designerFilled = 0, yearFilled = 0;
  const samples: string[] = [];

  for (const wd of wdCourses) {
    const cosLat = Math.cos((wd.lat * Math.PI) / 180);
    let best: PlaceRow | null = null;
    let bestD = Infinity;
    for (const r of rows) {
      const dLat = (r.lat - wd.lat) * 111_320;
      const dLon = (r.lng - wd.lon) * 111_320 * cosLat;
      const d = Math.hypot(dLat, dLon);
      if (d > MATCH_RADIUS_M || d >= bestD) continue;
      if (tokenOverlap(wd.name, r.name) < TOKEN_OVERLAP_MIN) continue;
      best = r;
      bestD = d;
    }
    if (!best) continue;
    matched++;
    if (samples.length < 10) {
      samples.push(`${wd.name} (${wd.qid}) -> ${best.slug} [${bestD.toFixed(0)}m]` + (wd.architects.length ? `, architect: ${wd.architects.join(", ")}` : "") + (wd.year ? `, year: ${wd.year}` : ""));
    }
    if (wd.architects.length && best.attrs.designer == null) {
      best.attrs.designer = wd.architects.join(", ");
      designerFilled++;
    }
    if (wd.year != null && best.attrs.yearOpened == null) {
      best.attrs.yearOpened = wd.year;
      yearFilled++;
    }
  }

  await writeFile(DATA + "places.json", JSON.stringify(rows));
  console.log(`enrich-wikidata: ${matched}/${wdCourses.length} wikidata courses matched (>=${TOKEN_OVERLAP_MIN} name overlap, <${MATCH_RADIUS_M}m)`);
  console.log(`enrich-wikidata: designer filled ${designerFilled}, yearOpened filled ${yearFilled}`);
  console.log("enrich-wikidata: sample matches:");
  for (const s of samples) console.log(`  ${s}`);
}
