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
}

type Tuple = [string, string, number, number, string];

export const pins: Pin[] = (raw as Tuple[]).map(([slug, name, lat, lng, region]) => ({
  slug,
  name,
  lat,
  lng,
  region,
}));

export const pinsGeoJSON = {
  type: "FeatureCollection" as const,
  features: pins.map((p) => ({
    type: "Feature" as const,
    id: p.slug,
    properties: { slug: p.slug, name: p.name, region: p.region },
    geometry: { type: "Point" as const, coordinates: [p.lng, p.lat] },
  })),
};

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]/g, "");

/** Simple in-memory prefix/substring search over 12k names — instant, offline. */
export function searchPins(query: string, limit = 20): Pin[] {
  const q = norm(query).trim();
  if (q.length < 2) return [];
  const starts: Pin[] = [];
  const contains: Pin[] = [];
  for (const p of pins) {
    const n = norm(p.name);
    if (n.startsWith(q)) starts.push(p);
    else if (n.includes(q)) contains.push(p);
    if (starts.length >= limit) break;
  }
  return [...starts, ...contains].slice(0, limit);
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
