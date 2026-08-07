/** Raw element from Overpass (OSM query API). */
export interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  /** Present when the query used `out geom;` — full node-by-node line geometry. */
  geometry?: { lat: number; lon: number }[];
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
    /** Derived from mapped hole/green ways; filter tags only, never displayed. */
    holesEst?: number;
    /**
     * Display-grade. Explicit `par=` course tag when present; otherwise the
     * sum of per-hole `par=` tags across a complete, numerically-ref'd hole
     * set (see enrich-par.ts) — still a measured value, just assembled from
     * finer-grained OSM data instead of a course-level tag.
     */
    par?: number;
    access?: "public" | "private" | "semi-private" | "municipal" | "resort" | "unknown";
    website?: string;
    yearOpened?: number;
    /**
     * Display-grade (always paired with lengthEst=true so the UI can label
     * it "approx"). Sum of haversine hole-geometry lengths for a complete
     * hole set, converted to yards and rounded to the nearest 10.
     */
    lengthYds?: number;
    /** True when lengthYds is a geometry-derived estimate rather than a stated fact. */
    lengthEst?: boolean;
    /** Filter-grade. max-min elevation (m) across sampled course points; drives the "mountain"/"hilly" signals. */
    elevRangeM?: number;
    /** Filter-grade. Long-term mean 10m wind speed (m/s, one decimal) at the course centroid; drives the "windy" signal. */
    windMs?: number;
    /** Filter-grade. Environment tags derived from geo rasters/vectors: coastal, desert, mountain, wooded, open, links. */
    setting?: string[];
    /** Filter-grade. Longest contiguous playable month range [start,end], 1-12, wrap allowed (e.g. [10,5]). From NOAA normals. */
    seasonMonths?: [number, number];
    /** Display-grade. Comma-joined architect name(s) from Wikidata (P84/P287), filled only where absent. */
    designer?: string;
  };
  source: "osm" | "manual";
  source_ref: string; // e.g. "way/12345" or "manual/<slug>"
}
