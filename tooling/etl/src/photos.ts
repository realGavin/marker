import { readFile, writeFile, mkdir, stat, readdir } from "node:fs/promises";
import type { PlaceRow } from "./types.js";

const DATA = new URL("../data/", import.meta.url).pathname;
const OUT = DATA + "photos/";

/**
 * One-time aerial photo per course from USGS NAIP (public domain, free).
 * ~1.1 GB total; served flat-cost from R2 via the tile worker's /photos route.
 * Resumable: already-downloaded slugs are skipped, so rerun until it converges.
 */
const SERVICE =
  "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage";

// Frame ~1.76 km x 1.1 km around the centroid: fills the view with the course.
const HALF_LAT_M = 550;
const HALF_LNG_M = 880;
const SIZE = "800,500";
const CONCURRENCY = 6;
// Blank/no-coverage exports (AK, HI, territories) compress to almost nothing.
const MIN_BYTES = 8_000;

function bbox(lat: number, lng: number): string {
  const dLat = HALF_LAT_M / 111_320;
  const dLng = HALF_LNG_M / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat].join(",");
}

async function fetchOne(row: PlaceRow): Promise<"ok" | "blank" | "fail"> {
  const url = `${SERVICE}?bbox=${bbox(row.lat, row.lng)}&bboxSR=4326&size=${SIZE}&format=jpg&compressionQuality=75&f=image`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "marker-etl/1.0" } });
      if (res.ok && res.headers.get("content-type")?.includes("image")) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < MIN_BYTES) return "blank";
        await writeFile(OUT + row.slug + ".jpg", buf);
        return "ok";
      }
    } catch {
      // fall through to backoff
    }
    await new Promise((r) => setTimeout(r, 2_000 * (attempt + 1)));
  }
  return "fail";
}

export async function photos(): Promise<void> {
  const rows: PlaceRow[] = JSON.parse(await readFile(DATA + "places.json", "utf8"));
  await mkdir(OUT, { recursive: true });
  const have = new Set(await readdir(OUT));
  const todo = rows.filter((r) => !have.has(r.slug + ".jpg"));
  console.log(`photos: ${rows.length} places, ${have.size} done, ${todo.length} to fetch`);

  let ok = 0, blank = 0, fail = 0, i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const row = todo[i++];
      if (!row) break;
      const r = await fetchOne(row);
      if (r === "ok") ok++;
      else if (r === "blank") blank++;
      else fail++;
      const n = ok + blank + fail;
      if (n % 200 === 0) console.log(`photos: ${n}/${todo.length} (ok ${ok}, blank ${blank}, fail ${fail})`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`photos done: ok ${ok}, blank ${blank}, fail ${fail} (rerun to retry fails)`);
}

/** Total size + count sanity check after a run. */
export async function photosReport(): Promise<void> {
  const files = (await readdir(OUT)).filter((f) => f.endsWith(".jpg"));
  let bytes = 0;
  for (const f of files) bytes += (await stat(OUT + f)).size;
  console.log(`photos: ${files.length} files, ${(bytes / 1e9).toFixed(2)} GB`);
}
