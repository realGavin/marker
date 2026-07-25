import type { CuratedListSeed } from "@marker/core";

/**
 * Curated starter lists. placeSlugs are filled in during M1 once the course
 * database exists and slugs are stable; empty arrays are valid stubs for M0.
 * Membership is our own editorial selection based on public knowledge — we do
 * not reproduce any publication's ranked list.
 */
export const curatedLists: CuratedListSeed[] = [
  {
    slug: "iconic-us-public",
    title: "100 Iconic U.S. Public Courses",
    description: "Bucket-list publics every traveling golfer should see.",
    placeSlugs: [],
  },
  {
    slug: "major-venues",
    title: "Major Championship Venues",
    description: "U.S. courses that have hosted a men's or women's major.",
    placeSlugs: [],
  },
  {
    slug: "americas-links",
    title: "True Links of America",
    description: "The rare genuine links experiences on U.S. soil.",
    placeSlugs: [],
  },
];
