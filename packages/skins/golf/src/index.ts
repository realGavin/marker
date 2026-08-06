import { z } from "zod";
import type { Skin } from "@marker/core";
import { curatedLists } from "../seeds/curated-lists";
import { tripTemplates } from "../seeds/trip-templates";

/** Golf-specific facts stored in a place row's `attrs` JSONB. All optional: open data is sparse. */
export const golfAttributes = z.object({
  holes: z.number().int().min(1).max(45).optional(),
  par: z.number().int().min(27).max(80).optional(),
  courseType: z.enum(["links", "parkland", "desert", "mountain", "heathland", "resort", "unknown"]).optional(),
  access: z.enum(["public", "private", "semi-private", "municipal", "resort", "unknown"]).optional(),
  designer: z.string().optional(),
  yearOpened: z.number().int().min(1700).max(2100).optional(),
  /** Coarse price band only — never exact prices (grounding rule). */
  greenFeeBand: z.enum(["$", "$$", "$$$", "$$$$"]).optional(),
  website: z.string().url().optional(),
});

export type GolfAttributes = z.infer<typeof golfAttributes>;

export const golfSkin: Skin = {
  nicheId: "golf",
  vocab: {
    place: "course",
    places: "courses",
    visited: "Played",
    wantTo: "Want to play",
    myPlaces: "My courses",
    planTrip: "Plan a golf trip",
    visitTime: "Tee time",
    visitTimes: "Tee times",
    setVisitTime: "Set a tee time",
    appName: "Marker Golf",
  },
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
  attributeFacts: (attrs: unknown) => {
    const parsed = golfAttributes.safeParse(attrs);
    if (!parsed.success) return [];
    const a = parsed.data;
    const facts: Array<{ label: string; value: string }> = [];
    if (a.holes) facts.push({ label: "Holes", value: String(a.holes) });
    if (a.par) facts.push({ label: "Par", value: String(a.par) });
    if (a.courseType && a.courseType !== "unknown")
      facts.push({ label: "Type", value: a.courseType[0]!.toUpperCase() + a.courseType.slice(1) });
    if (a.access && a.access !== "unknown")
      facts.push({ label: "Access", value: a.access[0]!.toUpperCase() + a.access.slice(1) });
    if (a.designer) facts.push({ label: "Designer", value: a.designer });
    if (a.yearOpened) facts.push({ label: "Opened", value: String(a.yearOpened) });
    if (a.greenFeeBand) facts.push({ label: "Green fees", value: a.greenFeeBand });
    return facts;
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
  pinFilterGroups: [
    { key: "holes", label: "Holes" },
    { key: "access", label: "Access" },
  ],
  pinFilters: [
    { key: "18", label: "18 holes", group: "holes" },
    { key: "9", label: "9 holes", group: "holes" },
    { key: "public", label: "Public", group: "access" },
    { key: "private", label: "Private", group: "access" },
  ],
};

export default golfSkin;
