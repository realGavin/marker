import { z } from "zod";
import type { Skin } from "@marker/core";
import { curatedLists } from "../seeds/curated-lists";
import { tripTemplates } from "../seeds/trip-templates";

/** Golf-specific facts stored in a place row's `attrs` JSONB. All optional: open data is sparse. */
export const golfAttributes = z.object({
  holes: z.number().int().min(1).max(45).optional(),
  par: z.number().int().min(27).max(80).optional(),
  // ("links" was cut from every enum in this skin: OSM's golf:links is a
  // sub-course grouping label, not a links-style indicator, so no row can
  // honestly carry the signal — see the pinFilters note below.)
  courseType: z.enum(["parkland", "desert", "mountain", "heathland", "resort", "unknown"]).optional(),
  access: z.enum(["public", "private", "semi-private", "municipal", "resort", "unknown"]).optional(),
  designer: z.string().optional(),
  yearOpened: z.number().int().min(1700).max(2100).optional(),
  /** Coarse price band only — never exact prices (grounding rule). */
  greenFeeBand: z.enum(["$", "$$", "$$$", "$$$$"]).optional(),
  website: z.string().url().optional(),
  // --- Course Intelligence Pack (written by tooling/etl) ---
  /** Total scorecard length in yards. */
  lengthYds: z.number().int().min(800).max(8500).optional(),
  /** True when lengthYds is derived/estimated rather than sourced; renders with a "≈" prefix. */
  lengthEst: z.boolean().optional(),
  /** Elevation spread across the property in metres (max minus min). */
  elevRangeM: z.number().int().min(0).max(400).optional(),
  /** Mean wind speed in metres per second. */
  windMs: z.number().min(0).max(20).optional(),
  /** Landscape descriptors; multiple can apply (e.g. coastal + open). */
  setting: z.array(z.enum(["coastal", "wooded", "open", "desert", "mountain"])).optional(),
  /** Playable window as [startMonth, endMonth], 1-indexed; may wrap (e.g. [10, 5]). */
  seasonMonths: z.tuple([z.number().int().min(1).max(12), z.number().int().min(1).max(12)]).optional(),
});

export type GolfAttributes = z.infer<typeof golfAttributes>;

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const SETTING_LABELS: Record<NonNullable<GolfAttributes["setting"]>[number], string> = {
  coastal: "Coastal",
  wooded: "Wooded",
  open: "Open",
  desert: "Desert",
  mountain: "Mountain",
};

/**
 * Terrain summary split into its display parts: a word every course gets, and
 * a rise only meaningful ground gets. Flat ground gets no number.
 * Stored in metres (the source rasters are metric); shown in feet, because
 * US golfers read elevation in feet. Cutoffs are the metric ones the pin tags
 * and planner prompt use — 15 m and 40 m — so every surface agrees.
 */
function elevationParts(m: number): { word: string; range: string | null } {
  if (m < 15) return { word: "Flat", range: null };
  const ft = Math.round((m * 3.28084) / 5) * 5; // nearest 5 ft: the input is an estimate
  return { word: m <= 40 ? "Rolling" : "Hilly", range: `${ft} ft` };
}

/** "Rolling · 28 m" style terrain summary; flat ground gets no number. */
function elevationLabel(m: number): string {
  const { word, range } = elevationParts(m);
  return range ? `${word} · ${range}` : word;
}

/** [3, 11] -> "Mar–Nov"; [1, 12] -> "Year-round"; [10, 5] -> "Oct–May". */
function seasonLabel([start, end]: [number, number]): string {
  if (start === 1 && end === 12) return "Year-round";
  const from = MONTH_NAMES[start - 1]!;
  const to = MONTH_NAMES[end - 1]!;
  return from === to ? from : `${from}–${to}`;
}

/** Pulled out (rather than inlined below) so externalLinks can reuse a label. */
const vocab = {
  place: "course",
  places: "courses",
  visited: "Played",
  wantTo: "Want to play",
  myPlaces: "My courses",
  planTrip: "Plan a golf trip",
  visitTime: "Tee time",
  visitTimes: "Tee times",
  setVisitTime: "Set a tee time",
  tripStops: "Rounds",
  tripNotesHint: "Anything else? (walkable, coastal, resort…)",
  appName: "Marker Golf",
  reporterNoun: "golfers",
    reporterNounSingular: "golfer",
};

export const golfSkin: Skin = {
  nicheId: "golf",
  vocab,
  // "Machined Light": paper-white surfaces, black controls, hairline borders,
  // sharp corners, gold as the single signal color, green reserved for
  // played-state data (pins), never chrome.
  theme: {
    colors: {
      primary: "#141414",
      primaryDark: "#000000",
      background: "#F5F5F3",
      surface: "#FFFFFF",
      textPrimary: "#141414",
      textSecondary: "#85858A",
      accent: "#A8871E",
      accentFill: "#C9A227",
      hairline: "#DADAD6",
      visitedPin: "#2C5F49",
      defaultPin: "#B9BDB4",
      wantPin: "#C9A227",
    },
    radii: { card: 4, control: 3, chip: 3, sheet: 8 },
    typography: {
      display: { fontSize: 22, fontWeight: "300", letterSpacing: 2, uppercase: true },
      heading: { fontSize: 14, fontWeight: "500", letterSpacing: 1.2, uppercase: true },
      label: { fontSize: 10, letterSpacing: 1.5 },
      numeral: { fontSize: 22, fontWeight: "200" },
    },
  },
  attributeSchema: golfAttributes,
  // The first four facts carry `cluster` payloads: the engine renders those as
  // the instrument strip (numeral over a caps unit) and everything after as
  // label/value rows. Splitting numeral from unit here is what keeps the
  // engine from having to parse golf strings back apart.
  attributeFacts: (attrs: unknown) => {
    const parsed = golfAttributes.safeParse(attrs);
    if (!parsed.success) return [];
    const a = parsed.data;
    const facts: ReturnType<Skin["attributeFacts"]> = [];
    if (a.holes)
      facts.push({
        label: "Holes",
        value: String(a.holes),
        cluster: { numeral: String(a.holes), unit: "Holes" },
      });
    // Par is assembled from per-hole tags rather than read off a scorecard —
    // measured, but derived.
    if (a.par)
      facts.push({
        label: "Par",
        value: String(a.par),
        cluster: { numeral: String(a.par), unit: "Par" },
        derived: true,
      });
    if (a.lengthYds !== undefined) {
      const numeral = a.lengthYds.toLocaleString("en-US");
      facts.push({
        label: "Length",
        value: `${a.lengthEst ? "≈" : ""}${numeral} yds`,
        cluster: { numeral, unit: a.lengthEst ? "≈ yds" : "yds" },
        derived: true,
      });
    }
    if (a.elevRangeM !== undefined) {
      const { word, range } = elevationParts(a.elevRangeM);
      facts.push({
        label: "Elevation",
        value: elevationLabel(a.elevRangeM),
        cluster: { numeral: word, unit: range ?? "Terrain" },
        derived: true,
      });
    }
    if (a.courseType && a.courseType !== "unknown")
      facts.push({ label: "Type", value: a.courseType[0]!.toUpperCase() + a.courseType.slice(1) });
    if (a.access && a.access !== "unknown")
      facts.push({ label: "Access", value: a.access[0]!.toUpperCase() + a.access.slice(1) });
    if (a.designer) facts.push({ label: "Designer", value: a.designer });
    if (a.yearOpened) facts.push({ label: "Opened", value: String(a.yearOpened) });
    if (a.greenFeeBand) facts.push({ label: "Green fees", value: a.greenFeeBand });
    // Playable window comes from climate data, not from the club.
    if (a.seasonMonths) facts.push({ label: "Season", value: seasonLabel(a.seasonMonths), derived: true });
    return facts;
  },
  // Display-only descriptors for the chip row; the map filters below are the
  // machine-readable version of the same signals.
  settingChips: (attrs: unknown) => {
    const parsed = golfAttributes.safeParse(attrs);
    if (!parsed.success) return [];
    const a = parsed.data;
    const chips = (a.setting ?? []).map((s) => SETTING_LABELS[s]);
    // > 4 m/s long-term mean = top ~5% of US courses (median is 2.2) — the
    // honest bar for "notably windy". No "Calm" chip: nearly everything would
    // qualify, which tells the user nothing.
    if (a.windMs !== undefined && a.windMs > 4) chips.push("Windy");
    return chips;
  },
  curatedLists,
  tripTemplates,
  introSlides: [
    {
      icon: "map",
      title: "Every course, one map",
      body: "12,000+ US golf courses on a map that works offline. Find them anywhere, from majors venues to your local muni.",
    },
    {
      icon: "checkmark-circle",
      title: "Log every round",
      body: "Mark courses played, rate them out of 10, and chase bucket lists like the Top 100 Publics.",
    },
    {
      icon: "share-social",
      title: "Share your course map",
      body: "Your played courses become a beautiful card worth showing off.",
    },
  ],
  // Keys match tags the ETL writes into pins.json: hole counts derived from
  // mapped hole/green ways, access from explicit tags + name signals.
  // Access tags are complementary: "private" = explicit tag or Country Club
  // name (~25%, matching the real-world private share); "public" = everything
  // without a private signal — the honest proxy, since explicit public tagging
  // in the source data is ~2.5%.
  // Terrain/character/length tags come from the Course Intelligence Pack ETL
  // pass. Coverage is uneven by design (open data is sparse): the architect
  // prunes any chip whose tag covers under 10% of pins before ship, so a
  // filter never looks broken by returning almost nothing.
  // What a golfer would actually flag after a round. Keys are stored in the
  // database and must never change; labels are display-only.
  conditionKinds: [
    { key: "greens", label: "Greens" },
    { key: "bunkers", label: "Bunkers" },
    { key: "fairways", label: "Fairways" },
    { key: "rough", label: "Rough" },
    { key: "cart_paths", label: "Cart paths" },
    { key: "pace", label: "Pace of play" },
    { key: "drainage", label: "Wet / drainage" },
  ],
  pinFilterGroups: [
    { key: "holes", label: "Holes" },
    { key: "access", label: "Access" },
    { key: "terrain", label: "Terrain" },
    { key: "character", label: "Character" },
    { key: "length", label: "Length" },
  ],
  pinFilters: [
    { key: "18", label: "18 holes", group: "holes" },
    { key: "9", label: "9 holes", group: "holes" },
    { key: "public", label: "Public", group: "access" },
    { key: "private", label: "Private", group: "access" },
    // ("Links" was cut: OSM's golf:links is a sub-course grouping label, not a
    // links-style indicator — inland courses carry it, so it can't ship.)
    { key: "coastal", label: "Coastal", group: "terrain" },
    { key: "wooded", label: "Wooded", group: "terrain" },
    { key: "open", label: "Open", group: "terrain" },
    { key: "desert", label: "Desert", group: "terrain" },
    { key: "mountain", label: "Mountain", group: "terrain" },
    { key: "windy", label: "Windy", group: "character" },
    { key: "hilly", label: "Hilly", group: "character" },
    { key: "short", label: "Short (<5,800 yds)", group: "length" },
    { key: "long", label: "Long (>6,800 yds)", group: "length" },
  ],
  // Outbound quick actions shown on the place detail page. Each url() is a
  // pure function of the place; the engine drops any entry that returns null
  // (e.g. no website on file) rather than rendering a dead link.
  //
  // Apple Maps "Directions" and a GolfNow-style tee-time search used to live
  // here too. Cut both: Directions was redundant with Google Maps below
  // (which already opens a map, one tap away from turn-by-turn), and the
  // tee-time entry was just a disguised web search, not a real booking flow.
  // A real booking deep link can slot back in here if a partner integration
  // (e.g. GolfNow's affiliate program) ever supplies one — no engine changes
  // needed either way, since the engine just renders whatever this array
  // returns non-null for.
  externalLinks: [
    {
      key: "reviews",
      label: "Google Maps",
      icon: "star-outline",
      // Google Maps place search: shows Google's rating/reviews/photos AND
      // directions for the course in one tap, without needing a Places API
      // key. Name + city + region disambiguates courses that share a name
      // across metros.
      url: (place) => {
        const query = [place.name, place.city, place.region].filter(Boolean).join(" ");
        return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
      },
    },
    {
      key: "website",
      label: "Website",
      icon: "globe-outline",
      // Only ~55% of courses have a known official site; null hides the item.
      url: (place) => place.website,
    },
  ],
};

export default golfSkin;
