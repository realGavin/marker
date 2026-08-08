/**
 * The bundled place-pin directory: ships inside the app binary, so the map and
 * search work offline with zero network calls (flat-cost constraint).
 */
import raw from "../../assets/data/pins.json";

export interface Pin {
  slug: string;
  name: string;
  lat: number;
  lng: number;
  region: string;
  /** Filter tags emitted by the ETL; keys match skin.pinFilters. */
  tags: string[];
  city: string | null;
}

type Tuple = [string, string, number, number, string, string[]?, (string | null)?];

export const pins: Pin[] = (raw as Tuple[]).map(([slug, name, lat, lng, region, tags, city]) => ({
  slug,
  name,
  lat,
  lng,
  region,
  tags: tags ?? [],
  city: city ?? null,
}));

export function toGeoJSON(rows: Pin[]) {
  return {
    type: "FeatureCollection" as const,
    features: rows.map((p) => ({
      type: "Feature" as const,
      id: p.slug,
      properties: { slug: p.slug, name: p.name, region: p.region },
      geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
    })),
  };
}

export const pinsGeoJSON = toGeoJSON(pins);

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, "");

/**
 * In-memory search over 12k places — instant, offline. Matches the place name
 * first, then the city ("Monterey" surfaces that town's places even when no
 * name contains it), so people can search the way they think: by destination.
 */
export function searchPins(query: string, limit = 20): Pin[] {
  const q = norm(query).trim();
  if (q.length < 2) return [];
  const nameStarts: Pin[] = [];
  const nameContains: Pin[] = [];
  const cityMatches: Pin[] = [];
  for (const p of pins) {
    const n = norm(p.name);
    if (n.startsWith(q)) nameStarts.push(p);
    else if (n.includes(q)) nameContains.push(p);
    else if (p.city && norm(p.city).startsWith(q)) cityMatches.push(p);
    if (nameStarts.length >= limit) break;
  }
  return [...nameStarts, ...nameContains, ...cityMatches].slice(0, limit);
}

// US state/territory name -> 2-letter code. Geography, not niche vocabulary —
// used to make "California" and "CA" both resolve to places *in* CA, rather
// than places merely *named* California.
const US_STATE_LIST: [name: string, code: string][] = [
  ["Alabama", "AL"], ["Alaska", "AK"], ["Arizona", "AZ"], ["Arkansas", "AR"],
  ["California", "CA"], ["Colorado", "CO"], ["Connecticut", "CT"], ["Delaware", "DE"],
  ["Florida", "FL"], ["Georgia", "GA"], ["Hawaii", "HI"], ["Idaho", "ID"],
  ["Illinois", "IL"], ["Indiana", "IN"], ["Iowa", "IA"], ["Kansas", "KS"],
  ["Kentucky", "KY"], ["Louisiana", "LA"], ["Maine", "ME"], ["Maryland", "MD"],
  ["Massachusetts", "MA"], ["Michigan", "MI"], ["Minnesota", "MN"], ["Mississippi", "MS"],
  ["Missouri", "MO"], ["Montana", "MT"], ["Nebraska", "NE"], ["Nevada", "NV"],
  ["New Hampshire", "NH"], ["New Jersey", "NJ"], ["New Mexico", "NM"], ["New York", "NY"],
  ["North Carolina", "NC"], ["North Dakota", "ND"], ["Ohio", "OH"], ["Oklahoma", "OK"],
  ["Oregon", "OR"], ["Pennsylvania", "PA"], ["Rhode Island", "RI"], ["South Carolina", "SC"],
  ["South Dakota", "SD"], ["Tennessee", "TN"], ["Texas", "TX"], ["Utah", "UT"],
  ["Vermont", "VT"], ["Virginia", "VA"], ["Washington", "WA"], ["West Virginia", "WV"],
  ["Wisconsin", "WI"], ["Wyoming", "WY"], ["District of Columbia", "DC"],
];

/** Full state/territory name (normalized) -> 2-letter code. */
export const US_STATES: Record<string, string> = Object.fromEntries(
  US_STATE_LIST.map(([name, code]) => [norm(name), code]),
);
const CODE_TO_STATE_NAME: Record<string, string> = Object.fromEntries(
  US_STATE_LIST.map(([name, code]) => [code, name]),
);

/** A filter chip supplied by the active skin (skin.pinFilters), kept minimal so this file never imports a skin. */
export interface PinFilterOption {
  key: string;
  label: string;
}

export type SearchResult =
  | { kind: "place"; pin: Pin }
  | { kind: "city"; city: string; region: string; count: number; lat: number; lng: number }
  | { kind: "region"; region: string; regionName: string; count: number; lat: number; lng: number }
  | { kind: "tag"; key: string; label: string; count: number };

export interface SearchAllOptions {
  limit?: number;
  /** Filter chips to match against, e.g. skin.pinFilters — the caller supplies them so this module stays niche-agnostic. */
  tags?: PinFilterOption[];
}

interface CityEntry {
  city: string;
  region: string;
  count: number;
  lat: number;
  lng: number;
}
interface RegionEntry {
  count: number;
  lat: number;
  lng: number;
}

// Lazy, memoized indexes: built once on first search, not at import time
// (the pin array is 12.6k rows and most screens never search).
let cityIndex: Map<string, CityEntry> | null = null;
let regionIndex: Map<string, RegionEntry> | null = null;
let tagCounts: Map<string, number> | null = null;

function ensureIndexes() {
  if (cityIndex && regionIndex && tagCounts) return;
  const cities = new Map<string, { city: string; region: string; count: number; sumLat: number; sumLng: number }>();
  const regions = new Map<string, { count: number; sumLat: number; sumLng: number }>();
  const tags = new Map<string, number>();
  for (const p of pins) {
    if (p.city) {
      const key = `${norm(p.city)}|${p.region}`;
      const e = cities.get(key);
      if (e) {
        e.count++;
        e.sumLat += p.lat;
        e.sumLng += p.lng;
      } else {
        cities.set(key, { city: p.city, region: p.region, count: 1, sumLat: p.lat, sumLng: p.lng });
      }
    }
    const r = regions.get(p.region);
    if (r) {
      r.count++;
      r.sumLat += p.lat;
      r.sumLng += p.lng;
    } else {
      regions.set(p.region, { count: 1, sumLat: p.lat, sumLng: p.lng });
    }
    for (const t of p.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
  }
  cityIndex = new Map(
    [...cities].map(([key, v]) => [
      key,
      { city: v.city, region: v.region, count: v.count, lat: v.sumLat / v.count, lng: v.sumLng / v.count },
    ]),
  );
  regionIndex = new Map(
    [...regions].map(([region, v]) => [
      region,
      { count: v.count, lat: v.sumLat / v.count, lng: v.sumLng / v.count },
    ]),
  );
  tagCounts = tags;
}

/**
 * Typed, ranked search over places, cities, US states/territories, and the
 * caller's filter chips — offline, no fuzzy-match library. Fixes three
 * complaints in one pass: a state name (or its 2-letter code) resolves to
 * places *in* that state rather than places merely named after it; a
 * character/terrain word resolves to the matching filter chip; and a short
 * (2-char) query no longer floods the list with name-substring noise, since
 * the weak "name includes" match only kicks in at 3+ characters.
 *
 * Ranking: exact region/city matches first, then places whose name starts
 * with the query, then the remaining (prefix) city/region/tag matches, then
 * places whose name merely contains the query. City/region/tag entries are
 * capped (3/2/2 by default) so places still dominate the list.
 */
export function searchAll(query: string, opts: SearchAllOptions = {}): SearchResult[] {
  const limit = opts.limit ?? 20;
  const raw = query.trim();
  const q = norm(raw);
  if (q.length < 2) return [];
  ensureIndexes();

  const exact: SearchResult[] = [];
  const placeStarts: SearchResult[] = [];
  const rest: SearchResult[] = [];
  const placeIncludes: SearchResult[] = [];

  // --- region: exact 2-letter code, exact full name, or a >=4-char name prefix ---
  const codeQuery = raw.toUpperCase();
  const regionRows = [...regionIndex!.entries()].sort((a, b) => b[1].count - a[1].count);
  let regionCount = 0;
  for (const [region, v] of regionRows) {
    if (regionCount >= 2) break;
    const regionName = CODE_TO_STATE_NAME[region] ?? region;
    const nameNorm = norm(regionName);
    const isExactCode = codeQuery.length === 2 && codeQuery === region;
    const isExactName = nameNorm === q;
    const isPrefix = q.length >= 4 && nameNorm.startsWith(q);
    if (!isExactCode && !isExactName && !isPrefix) continue;
    const entry: SearchResult = { kind: "region", region, regionName, count: v.count, lat: v.lat, lng: v.lng };
    if (isExactCode || isExactName) exact.push(entry);
    else rest.push(entry);
    regionCount++;
  }

  // --- city: name startsWith query, >=2 chars ---
  const cityRows = [...cityIndex!.entries()].sort((a, b) => b[1].count - a[1].count);
  let cityCount = 0;
  for (const [, v] of cityRows) {
    if (cityCount >= 3) break;
    const nameNorm = norm(v.city);
    if (!nameNorm.startsWith(q)) continue;
    const entry: SearchResult = { kind: "city", city: v.city, region: v.region, count: v.count, lat: v.lat, lng: v.lng };
    if (nameNorm === q) exact.push(entry);
    else rest.push(entry);
    cityCount++;
  }

  // --- tag: caller-supplied filter label startsWith query, >=3 chars ---
  if (q.length >= 3 && opts.tags) {
    const tagRows = opts.tags
      .map((f) => ({ f, count: tagCounts!.get(f.key) ?? 0 }))
      .filter(({ f, count }) => count > 0 && norm(f.label).startsWith(q))
      .sort((a, b) => b.count - a.count);
    let tagCount = 0;
    for (const { f, count } of tagRows) {
      if (tagCount >= 2) break;
      rest.push({ kind: "tag", key: f.key, label: f.label, count });
      tagCount++;
    }
  }

  // --- place: name startsWith (strong), name includes (weak, >=3 chars) ---
  for (const p of pins) {
    const n = norm(p.name);
    if (n.startsWith(q)) placeStarts.push({ kind: "place", pin: p });
    else if (q.length >= 3 && n.includes(q)) placeIncludes.push({ kind: "place", pin: p });
  }

  return [...exact, ...placeStarts, ...rest, ...placeIncludes].slice(0, limit);
}

export function nearest(lat: number, lng: number, limit = 25): Pin[] {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  return [...pins]
    .sort((a, b) => {
      const da = (a.lat - lat) ** 2 + ((a.lng - lng) * cosLat) ** 2;
      const db = (b.lat - lat) ** 2 + ((b.lng - lng) * cosLat) ** 2;
      return da - db;
    })
    .slice(0, limit);
}
