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
  /** a scheduled visit slot, e.g. "Trailhead time" */
  visitTime: string;
  /** plural of visitTime */
  visitTimes: string;
  /** CTA to schedule one, e.g. "Set a start time" */
  setVisitTime: string;
  /** label for the per-trip activity count, e.g. "Hikes" */
  tripStops: string;
  /** placeholder example text for the trip notes field, e.g. "Anything else? (elevation gain, shade, permits…)" */
  tripNotesHint: string;
  /** App display name for this niche, e.g. "Marker Trails" */
  appName: string;
  /** Plural noun for a visitor who files a condition report, e.g. "hikers" */
  reporterNoun: string;
  /** Singular of reporterNoun, e.g. "hiker" — endorsement counts start at 1. */
  reporterNounSingular: string;
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
    /** Saturated accent for fills where text contrast doesn't apply. */
    accentFill: string;
    /** 1px border color; this design language uses hairlines, not shadows. */
    hairline: string;
    visitedPin: string;
    defaultPin: string;
    wantPin: string;
  };
  /** Shape language: small radii read machined, large read soft. */
  radii: {
    card: number;
    control: number;
    chip: number;
    sheet: number;
  };
  typography: {
    /** Large screen/place titles. */
    display: { fontSize: number; fontWeight: TextWeight; letterSpacing: number; uppercase: boolean };
    /** Section headings. */
    heading: { fontSize: number; fontWeight: TextWeight; letterSpacing: number; uppercase: boolean };
    /** Tiny caps labels under numerals and on chips. */
    label: { fontSize: number; letterSpacing: number };
    /** Instrument-cluster numbers. */
    numeral: { fontSize: number; fontWeight: TextWeight };
  };
}

export type TextWeight = "200" | "300" | "400" | "500" | "600" | "700";

/** One welcome-carousel slide shown before sign-in. `icon` is an Ionicons name. */
export interface IntroSlide {
  icon: string;
  title: string;
  body: string;
}

/**
 * A toggleable map/search filter. `key` must match a tag the niche's ETL
 * writes into the bundled pin dataset (pins.json tuples carry a tags array).
 * Filters in the same `group` combine as OR (either matches); different
 * groups combine as AND — so multi-select never contradicts itself.
 */
export interface PinFilter {
  key: string;
  label: string;
  /** Group key; must exist in Skin.pinFilterGroups. */
  group: string;
}

/** Section header for a set of pin filters shown in the filter menu. */
export interface PinFilterGroup {
  key: string;
  label: string;
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

/**
 * Data an `externalLinks` `url()` builder needs about a place. Deliberately
 * minimal and niche-neutral — just enough for a mapping, review, or booking
 * provider to find the place: a display name, coarse location for a text
 * search query, coordinates for a native map deep link, and an optional
 * official website.
 */
export interface ExternalLinkPlace {
  name: string;
  city: string | null;
  region: string | null;
  lat: number;
  lng: number;
  website: string | null;
}

/**
 * One outbound "quick action" shown on the place detail page — e.g.
 * directions, third-party reviews, or a booking provider. `icon` is an
 * Ionicons name. `url` is a pure function: place in, an absolute URL out, or
 * `null` when this link doesn't apply to this place (e.g. no known website) —
 * the engine renders nothing for a `null` result rather than a dead link.
 * The engine never knows what a given entry is *for*; it just maps over this
 * array and renders whatever the skin returns, so a future niche can point
 * these at entirely different providers without the engine changing at all.
 */
export interface ExternalLink {
  key: string;
  label: string;
  icon: string;
  url: (place: ExternalLinkPlace) => string | null;
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
   * Pure function: attrs in, ordered display-ready entries out. The engine
   * never parses or re-splits these strings — it reads only the fields below,
   * so the skin owns every word and every number the fact block shows.
   *
   * Each entry:
   * - `label` / `value`: display-ready strings for a plain fact row, e.g.
   *   { label: "Surface", value: "Packed gravel" } in a hiking niche.
   * - `cluster`: present when the fact should also read as an instrument —
   *   a big figure with a tiny caps unit under it — instead of a row.
   *   `numeral` is the figure, `unit` the caps label. A hiking Distance fact
   *   clusters as { numeral: "14.2", unit: "≈ km" }; the skin decides the
   *   split, including where an "≈" or a unit word goes. `value` stays the
   *   readable one-string form and is unused while `cluster` is present.
   * - `derived`: true when the fact is computed from open data rather than
   *   stated by a source — e.g. a distance measured off the mapped route
   *   instead of read from a trail sign. Still measured, still honest, just
   *   not authored; the engine discloses it.
   *
   * Engine rendering rule (fixed, so skins can rely on it):
   * facts WITH `cluster` render in the instrument strip as numeral + caps
   * unit label, in the order returned, capped at 4 (any beyond the 4th are
   * dropped, not demoted to rows); facts without `cluster` render as
   * label/value rows, also in the order returned; if any fact carries
   * `derived: true` — or the skin returns any settingChips — the engine
   * appends its generic data-provenance footnote.
   */
  attributeFacts: (attrs: unknown) => Array<{
    label: string;
    value: string;
    cluster?: { numeral: string; unit: string };
    derived?: boolean;
  }>;
  /**
   * Optional short display words derived from validated attrs, e.g.
   * ["Alpine", "Forested"] for a hiking niche. The engine renders them
   * generically as a chip row on the place page — it never interprets them,
   * so they must be display-ready, one or two words each, and few enough to
   * fit one line. Return [] when attrs don't validate or nothing applies.
   */
  settingChips?: (attrs: unknown) => string[];
  curatedLists: CuratedListSeed[];
  /** Precomputed trip inspiration shown on the trips surface. */
  tripTemplates: TripTemplate[];
  /** Welcome carousel shown before sign-in. */
  introSlides: IntroSlide[];
  /**
   * Categories a visitor can flag about a place's CURRENT state (e.g. a hiking
   * niche might offer trail washout, blowdowns, bridge out). `key` is stored in
   * the database and must be stable; `label` is display-only. The engine
   * renders these generically and never interprets them.
   */
  conditionKinds: Array<{ key: string; label: string }>;
  /** Filters offered in the map's filter menu; keys match pin-data tags. */
  pinFilters: PinFilter[];
  /** Section headers for pinFilters, in display order. */
  pinFilterGroups: PinFilterGroup[];
  /**
   * Outbound "quick actions" row on the place detail page (directions,
   * reviews, booking, website, …), in display order. The engine renders one
   * tappable item per entry and drops any whose `url()` returns `null` for
   * the current place — so a row with three available links looks just as
   * deliberate as one with four.
   */
  externalLinks: ExternalLink[];
}
