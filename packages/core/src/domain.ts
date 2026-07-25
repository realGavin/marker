/** Engine domain types — mirrors the database schema. Niche-agnostic by design. */

export type LogStatus = "visited" | "want";

export interface Place {
  id: string;
  nicheId: string;
  slug: string;
  name: string;
  lat: number;
  lng: number;
  city: string | null;
  region: string | null; // state/province
  country: string;
  attrs: unknown; // validated against the active skin's attributeSchema
  description: string | null;
}

export interface PlaceLog {
  id: string;
  userId: string;
  placeId: string;
  status: LogStatus;
  /** 0–10 in half steps (stored as 0–20 int in DB). */
  rating: number | null;
  note: string | null;
  visitedOn: string | null; // ISO date
}

export interface List {
  id: string;
  ownerId: string | null; // null = system/curated
  slug: string | null;
  title: string;
  description: string | null;
}

export type Tier = "free" | "pro";
