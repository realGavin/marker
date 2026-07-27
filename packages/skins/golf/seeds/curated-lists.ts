import type { CuratedListSeed } from "@marker/core";

/**
 * Curated starter lists. placeSlugs are resolved against the seeded places DB
 * (tooling/etl `seed-lists` upserts these). Membership is our own editorial
 * selection based on public knowledge — not any publication's ranked list.
 */
export const curatedLists: CuratedListSeed[] = [
  {
    slug: "iconic-publics",
    title: "Iconic American Publics",
    description: "Bucket-list public courses every traveling golfer should see.",
    placeSlugs: [
      "pebble-beach-golf-course-ca", "spyglass-hill-golf-course-ca", "the-links-at-spanish-bay-ca",
      "torrey-pines-north-course-ca", "tpc-harding-park-ca", "rustic-canyon-golf-course-ca",
      "pasatiempo-golf-course-ca", "tpc-stadium-golf-course-pga-west-ca", "half-moon-bay-golf-links-the-ocean-course-ca",
      "chambers-bay-golf-course-wa", "gold-mountain-golf-course-wa", "gamble-sands-golf-course-wa",
      "wine-valley-golf-club-wa", "palouse-ridge-golf-course-wa",
      "bandon-dunes-golf-resort-or", "pacific-dunes-or", "bandon-trails-or",
      "pumpkin-ridge-golf-club-or", "crosswater-golf-course-or",
      "tpc-sawgrass-fl", "streamsong-resort-black-course-fl", "innisbrook-golf-resort-fl", "pga-national-resort-fl",
      "kiawah-island-golf-resort-the-ocean-course-sc", "harbour-town-golf-links-sc",
      "caledonia-golf-and-fish-club-sc", "true-blue-golf-plantation-sc",
      "tobacco-road-golf-club-nc", "pinehurst-nc", "pine-needles-nc",
      "bethpage-state-park-golf-courses-ny", "montauk-downs-ny",
      "whistling-straits-wi", "blackwolf-run-wi", "erin-hills-wi", "sentryworld-golf-course-wi",
      "golf-courses-of-lawsonia-wi", "sand-valley-golf-resort-wi",
      "cog-hill-golf-and-country-club-il", "arcadia-bluffs-golf-club-mi", "forest-dunes-golf-resort-mi",
      "tpc-scottsdale-stadium-course-az", "grayhawk-golf-club-talon-course-az", "troon-north-golf-club-az",
      "we-ko-pa-golf-club-az", "papago-golf-club-az",
      "shadow-creek-golf-course-nv", "wolf-creek-golf-club-nv",
      "paa-ko-ridge-golf-club-nm", "black-mesa-golf-club-nm",
      "the-broadmoor-golf-courses-co", "memorial-park-golf-course-tx", "barton-creek-country-club-tx",
      "the-greenbrier-greenbrier-course-wv", "kapalua-plantation-course-hi", "ko-olina-golf-club-hi",
      "sweetens-cove-golf-club-tn", "kingsmill-resort-the-plantation-course-va",
      "williams-college-taconic-golf-course-ma", "red-tail-golf-course-ma", "bulle-rock-golf-club-md",
      "mount-washington-course-nh", "sugarloaf-golf-club-me", "belgrade-lakes-golf-club-me",
      "atlantic-city-golf-club-nj", "seaview-golf-club-bay-course-nj",
      "wild-horse-golf-club-ne", "the-prairie-club-ne", "sutton-bay-golf-course-sd",
      "old-works-golf-club-mt", "circling-raven-golf-course-id",
      "sand-hollow-resort-ut", "soldier-hollow-golf-course-ut",
    ],
  },
  {
    slug: "major-venues",
    title: "Major Championship Venues",
    description: "U.S. courses that have hosted the game's biggest championships.",
    placeSlugs: [
      "augusta-national-golf-club-ga", "oakmont-country-club-pa", "merion-golf-club-east-pa",
      "winged-foot-golf-club-ny", "shinnecock-hills-golf-club-ny", "the-country-club-ma",
      "baltusrol-golf-course-nj", "oak-hill-country-club-ny", "medinah-country-club-il",
      "bethpage-state-park-golf-courses-ny", "whistling-straits-wi", "erin-hills-wi",
      "chambers-bay-golf-course-wa", "pinehurst-nc", "kiawah-island-golf-resort-the-ocean-course-sc",
      "southern-hills-country-club-ok", "los-angeles-country-club-ca", "riviera-country-club-ca",
      "olympic-club-golf-course-ca", "torrey-pines-north-course-ca", "congressional-country-club-md",
      "quail-hollow-club-nc", "east-lake-golf-club-ga", "hazeltine-national-golf-course-mn",
      "oakland-hills-country-club-mi", "inverness-club-oh", "valhalla-golf-club-ky",
      "bellerive-country-club-mo", "pebble-beach-golf-course-ca", "shoal-creek-al",
    ],
  },
  {
    slug: "municipal-classics",
    title: "Great American Municipals",
    description: "Publicly owned gems that prove great golf belongs to everyone.",
    placeSlugs: [
      "bethpage-state-park-golf-courses-ny", "torrey-pines-north-course-ca", "chambers-bay-golf-course-wa",
      "papago-golf-club-az", "memorial-park-golf-course-tx", "tpc-harding-park-ca",
      "east-potomac-red-course-dc", "rancho-park-golf-course-ca", "jackson-park-golf-course-il",
      "corica-park-golf-course-ca", "keney-golf-course-ct", "winter-park-country-club-golf-course-fl",
      "goat-hill-park-golf-course-ca", "sharp-park-golf-course-ca", "soldier-hollow-golf-course-ut",
      "george-wright-golf-course-ma", "cobbs-creek-golf-course-olde-pa", "balboa-park-golf-course-ca",
      "brown-deer-park-golf-course-wi", "indian-canyon-golf-course-wa", "west-seattle-golf-course-wa",
      "grover-cleveland-golf-course-ny",
    ],
  },
];
