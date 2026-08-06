/**
 * Compose App Store screenshots: brand caption band above an inset device
 * screenshot, output at the 6.9" required size (1290x2796).
 *
 * Run from tooling/etl:  node src/store-shots.mjs
 * Input:  docs/store-screenshots/*.png (raw captures, already 1290x2796)
 * Output: docs/store-screenshots/final/NN-name.png
 */
import sharp from "sharp";
import { readFile, writeFile, mkdir } from "node:fs/promises";

const W = 1290;
const H = 2796;
const CAPTION_H = 330;
const SHOT_W = 1150;
const RADIUS = 12;

const CREAM = "#F5F5F3";
const GREEN = "#141414";
const GOLD = "#C9A227";
const MUTED = "#85858A";

const DIR = new URL("../../../docs/store-screenshots/", import.meta.url).pathname;

const SHOTS = [
  { file: "1-map.png", title: "Every course, one map", sub: "12,000+ US courses, filterable and offline" },
  { file: "2-preview.png", title: "Tap a pin, log a round", sub: "Aerial photos of nearly every course" },
  { file: "3-course.png", title: "Rate it. Remember it.", sub: "Ratings, private notes, similar courses" },
  { file: "4-profile.png", title: "Share your golf map", sub: "Your collection, your rank, one card" },
  { file: "7-itinerary.png", title: "Plan trips with friends", sub: "Real courses — never invented" },
  { file: "6-lists.png", title: "Chase the bucket lists", sub: "Track progress on the classics" },
];

/** Escape XML text nodes so ampersands/quotes in copy can't break the SVG. */
const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function captionSvg(title, sub) {
  return Buffer.from(`<svg width="${W}" height="${CAPTION_H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${CAPTION_H}" fill="${CREAM}"/>
  <text x="${W / 2}" y="150" text-anchor="middle" font-family="Helvetica Neue, Helvetica, Arial"
        font-size="62" font-weight="300" letter-spacing="6" fill="${GREEN}">${esc(title.toUpperCase())}</text>
  <text x="${W / 2}" y="222" text-anchor="middle" font-family="Helvetica Neue, Helvetica, Arial"
        font-size="40" font-weight="400" fill="${MUTED}">${esc(sub)}</text>
  <rect x="${W / 2 - 40}" y="262" width="80" height="6" rx="3" fill="${GOLD}"/>
</svg>`);
}

/** Simulator status bar height in the captured image; cropped so the inset
 *  starts at the app's own header rather than a floating clock and notch. */
const STATUS_BAR = 175;

async function compose({ file, title, sub }, index) {
  const shotH = H - CAPTION_H;
  const src = sharp(DIR + file);
  const { width: srcW = W, height: srcH = H } = await src.metadata();
  const bar = Math.round(STATUS_BAR * (srcW / W));
  const inner = await sharp(DIR + file)
    .extract({ left: 0, top: bar, width: srcW, height: srcH - bar })
    .resize({ width: SHOT_W, height: shotH - 60, fit: "cover", position: "top" })
    .composite([
      {
        input: Buffer.from(
          `<svg width="${SHOT_W}" height="${shotH - 60}"><rect width="${SHOT_W}" height="${shotH - 60}" rx="${RADIUS}" ry="${RADIUS}"/></svg>`,
        ),
        blend: "dest-in",
      },
    ])
    .png()
    .toBuffer();

  const out = await sharp({
    create: { width: W, height: H, channels: 4, background: CREAM },
  })
    .composite([
      { input: captionSvg(title, sub), top: 0, left: 0 },
      { input: inner, top: CAPTION_H, left: Math.round((W - SHOT_W) / 2) },
    ])
    .png()
    .toBuffer();

  const name = `${String(index + 1).padStart(2, "0")}-${file.replace(/^\d+-/, "")}`;
  await writeFile(DIR + "final/" + name, out);
  return name;
}

await mkdir(DIR + "final", { recursive: true });
for (const [i, shot] of SHOTS.entries()) {
  const name = await compose(shot, i);
  const meta = await sharp(DIR + "final/" + name).metadata();
  console.log(`${name}  ${meta.width}x${meta.height}`);
}
console.log("done");
