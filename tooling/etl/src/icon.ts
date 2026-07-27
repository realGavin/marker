import { readFile, writeFile } from "node:fs/promises";
// sharp lives in @xenova/transformers' tree; resolve from workspace root.
import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

/**
 * Brand assets from the data itself: the dot-map USA (every place in the
 * directory) on the deep-green field with one gold marker — the same motif
 * as the share card. Renders icon.png (1024) and splash-icon.png (512).
 */
export async function icon(): Promise<void> {
  const sharp = require_("sharp");
  const rows = JSON.parse(
    await readFile(new URL("../data/places.json", import.meta.url).pathname, "utf8"),
  ) as Array<{ lat: number; lng: number }>;

  const B = { west: -125, east: -66.5, south: 24, north: 49.5 };
  const SIZE = 1024;
  // dot field occupies the middle band of the icon
  const MAP_W = 820;
  const MAP_H = 500;
  const OX = (SIZE - MAP_W) / 2;
  const OY = (SIZE - MAP_H) / 2;

  const dots: string[] = [];
  for (let i = 0; i < rows.length; i += 2) {
    const r = rows[i];
    if (!r || r.lat < B.south || r.lat > B.north || r.lng < B.west || r.lng > B.east) continue;
    const x = OX + ((r.lng - B.west) / (B.east - B.west)) * MAP_W;
    const y = OY + ((B.north - r.lat) / (B.north - B.south)) * MAP_H;
    dots.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.9" fill="#57917A" opacity="0.85"/>`);
  }
  // gold marker on the Monterey coast — the brand's "you are here"
  const gx = OX + ((-121.95 - B.west) / (B.east - B.west)) * MAP_W;
  const gy = OY + ((B.north - 36.57) / (B.north - B.south)) * MAP_H;

  const svg = `<svg width="${SIZE}" height="${SIZE}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="bg" cx="50%" cy="38%" r="80%">
      <stop offset="0%" stop-color="#205746"/>
      <stop offset="100%" stop-color="#0F2E25"/>
    </radialGradient>
  </defs>
  <rect width="${SIZE}" height="${SIZE}" fill="url(#bg)"/>
  ${dots.join("\n  ")}
  <circle cx="${gx}" cy="${gy}" r="46" fill="#C9A227" opacity="0.30"/>
  <circle cx="${gx}" cy="${gy}" r="22" fill="#C9A227"/>
</svg>`;

  const appImages = new URL("../../../apps/mobile/assets/images/", import.meta.url).pathname;
  await sharp(Buffer.from(svg)).png().toFile(appImages + "icon.png");
  // splash glyph: transparent background, just the gold marker over faint dots
  const splashSvg = svg
    .replace(`<rect width="${SIZE}" height="${SIZE}" fill="url(#bg)"/>`, "")
    .replace(/opacity="0.75"/g, 'opacity="0.5"');
  await sharp(Buffer.from(splashSvg)).resize(512, 512).png().toFile(appImages + "splash-icon.png");
  console.log("icon.png (1024) and splash-icon.png (512) written");
}
