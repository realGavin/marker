/** Raw element from Overpass (OSM query API). */
export interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** Normalized course row, mirrors public.places. */
export interface PlaceRow {
  niche_id: string;
  slug: string;
  name: string;
  lat: number;
  lng: number;
  city: string | null;
  region: string | null; // state code, e.g. "CA"
  country: string;
  attrs: {
    holes?: number;
    par?: number;
    access?: "public" | "private" | "semi-private" | "municipal" | "resort" | "unknown";
    website?: string;
    yearOpened?: number;
  };
  source: "osm" | "manual";
  source_ref: string; // e.g. "way/12345" or "manual/<slug>"
}
