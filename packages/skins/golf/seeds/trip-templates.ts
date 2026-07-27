import type { TripTemplate } from "@marker/core";

/**
 * Precomputed trip inspiration — zero AI cost, pure editorial. Slugs are
 * verified against the seeded places DB (same set the curated lists use).
 */
export const tripTemplates: TripTemplate[] = [
  {
    slug: "bandon-pilgrimage",
    title: "The Bandon Pilgrimage",
    description: "Four days on Oregon's wild coast — the purest links golf in America.",
    days: 4,
    placeSlugs: [
      "bandon-dunes-golf-resort-or",
      "pacific-dunes-or",
      "bandon-trails-or",
    ],
  },
  {
    slug: "monterey-weekend",
    title: "Monterey Peninsula Weekend",
    description: "Pebble, Spyglass, and the coast road — the classic California splurge.",
    days: 3,
    placeSlugs: [
      "pebble-beach-golf-course-ca",
      "spyglass-hill-golf-course-ca",
      "the-links-at-spanish-bay-ca",
      "pasatiempo-golf-course-ca",
    ],
  },
  {
    slug: "scottsdale-winter",
    title: "Scottsdale in Winter",
    description: "Desert golf at its best while the rest of the country shovels snow.",
    days: 4,
    placeSlugs: [
      "tpc-scottsdale-stadium-course-az",
      "grayhawk-golf-club-talon-course-az",
      "troon-north-golf-club-az",
      "we-ko-pa-golf-club-az",
      "papago-golf-club-az",
    ],
  },
  {
    slug: "wisconsin-loop",
    title: "The Wisconsin Loop",
    description: "Whistling Straits to Sand Valley — America's unlikeliest great golf state.",
    days: 5,
    placeSlugs: [
      "whistling-straits-wi",
      "blackwolf-run-wi",
      "erin-hills-wi",
      "sand-valley-golf-resort-wi",
      "golf-courses-of-lawsonia-wi",
    ],
  },
];
