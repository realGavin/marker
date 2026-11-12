// Derives the demo page's dataset from the SAME pins file the app bundles.
// Parallel arrays + a tag bitmask, coords to 4dp (~11 m), no slugs.
import { readFile, writeFile } from "node:fs/promises";
const TAGS = ["18","9","public","private","wooded","open","desert","hilly","coastal","long","windy","mountain","short"];
const SRC = process.argv[2] ?? new URL("../apps/mobile/assets/data/pins.json", import.meta.url).pathname;
const OUT = process.argv[3] ?? new URL("../docs/demo-pins.json", import.meta.url).pathname;
const rows = JSON.parse(await readFile(SRC, "utf8"));
const out = { tags: TAGS, n: [], c: [], s: [], lat: [], lng: [], t: [] };
for (const [, name, lat, lng, state, tags, city] of rows) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
  let bits = 0;
  for (const tag of tags || []) { const i = TAGS.indexOf(tag); if (i >= 0) bits |= 1 << i; }
  out.n.push(name); out.c.push(city || ""); out.s.push(state || "");
  out.lat.push(Number(lat.toFixed(4))); out.lng.push(Number(lng.toFixed(4))); out.t.push(bits);
}
await writeFile(OUT, JSON.stringify(out));
console.log(`wrote ${out.n.length} courses to ${OUT}`);
