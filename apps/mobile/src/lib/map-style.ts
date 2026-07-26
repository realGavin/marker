import { layers, namedFlavor } from "@protomaps/basemaps";
import { env } from "./env";

/**
 * Basemap style assembled locally from the Protomaps layer definitions —
 * tiles come from OUR host (dev: local pmtiles server; prod: Cloudflare R2 +
 * worker), never a metered map API. Fonts/sprites are static Protomaps assets.
 */
const ASSETS = "https://protomaps.github.io/basemaps-assets";

export function buildMapStyle(): string {
  return JSON.stringify({
    version: 8,
    glyphs: `${ASSETS}/fonts/{fontstack}/{range}.pbf`,
    sprite: `${ASSETS}/sprites/v4/light`,
    sources: {
      protomaps: {
        type: "vector",
        tiles: [env.tileUrl],
        maxzoom: 14,
        attribution: "© OpenStreetMap contributors, Protomaps",
      },
    },
    layers: layers("protomaps", namedFlavor("light"), { lang: "en" }),
  });
}
