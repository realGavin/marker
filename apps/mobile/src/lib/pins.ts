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
