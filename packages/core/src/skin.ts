import type { z } from "zod";

/**
 * The Skin contract.
 *
 * The engine (apps/mobile) is 100% niche-agnostic: it renders vocabulary,
 * themes, attribute schemas, and seed content provided by exactly one Skin.
 * A new niche = a new package implementing this interface. Engine code must
 * never reference a specific niche (enforced by scripts/engine-purity-lint.mjs).
 */

/**
 * Words the UI uses for the niche's nouns/verbs. Keys are semantic, values are
 * display strings. Examples below use a hypothetical hiking niche.
 */
export interface SkinVocabulary {
  /** e.g. "trail" */
  place: string;
  /** plural, e.g. "trails" */
  places: string;
  /** past-tense verb for a completed visit, e.g. "Hiked" */
  visited: string;
  /** desire state, e.g. "Want to hike" */
  wantTo: string;
  /** the user's collection, e.g. "My trails" */
  myPlaces: string;
  /** trip planner CTA, e.g. "Plan a hiking trip" */
  planTrip: string;
  /** App display name for this niche, e.g. "Marker Trails" */
  appName: string;
}

export interface SkinTheme {
  colors: {
    primary: string;
    primaryDark: string;
    background: string;
    surface: string;
    textPrimary: string;
    textSecondary: string;
    accent: string;
    visitedPin: string;
    defaultPin: string;
    wantPin: string;
  };
}

/** A curated list shipped with the skin, seeded into the DB as owner='system'. */
export interface CuratedListSeed {
  slug: string;
  title: string;
  description: string;
  /** Ordered place slugs; resolved to place ids at seed time. */
  placeSlugs: string[];
}

/** A precomputed trip template (the zero-AI-cost "recommendor" content). */
export interface TripTemplate {
  slug: string;
  title: string;
  description: string;
  days: number;
  placeSlugs: string[];
}

export interface Skin {
  /** Stable niche identifier stored on every place row, e.g. "hiking". */
  nicheId: string;
  vocab: SkinVocabulary;
  theme: SkinTheme;
  /**
   * Zod schema validating the `attrs` JSONB blob on a place row.
   * Everything niche-specific about a place lives in `attrs`.
   */
  attributeSchema: z.ZodTypeAny;
  /**
   * Renders the niche facts shown on a place detail page from validated attrs.
   * Pure function: attrs in, ordered label/value pairs out.
   */
  attributeFacts: (attrs: unknown) => Array<{ label: string; value: string }>;
  curatedLists: CuratedListSeed[];
  /** Precomputed trip inspiration shown on the trips surface. */
  tripTemplates: TripTemplate[];
}
