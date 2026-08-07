import { readFile, writeFile } from "node:fs/promises";
import { fromUrl, type GeoTIFF } from "geotiff";
import type { PlaceRow } from "./types.js";
import { readPlaces, writePlaces, withPlacesLock } from "./places-io.js";

/**
 * Long-term mean 10m wind speed, from the Global Wind Atlas (DTU Wind
 * Energy / World Bank ESMAP, CC-BY-4.0): https://globalwindatlas.info.
 * The GWA site's "download by country" API redirects to a stable,
 * no-auth CloudFront/S3 GeoTIFF per country — confirmed working:
 *   https://globalwindatlas.info/api/gis/country/USA/wind-speed/10
 *   -> https://gwa.cdn.nazkamapps.com/country_tifs_v4/USA_wind-speed_10m.tif
 * That TIFF is a full-country raster (~800MB) but it's a tiled COG, so we
 * read it via HTTP range requests (geotiff.js `fromUrl` + windowed
 * `readRasters`) instead of downloading it — one small ranged GET per course,
 * no local cache file needed. Long-term mean at 10m is exactly the
 * "long-term mean wind speed at 10m" the task calls for, no unit conversion.
 *
 * Resumable: data/wind-state.json maps slug -> windMs, flushed periodically.
 */

const GWA_URL = "https://gwa.cdn.nazkamapps.com/country_tifs_v4/USA_wind-speed_10m.tif";
const DATA = new URL("../data/", import.meta.url).pathname;
const STATE_FILE = DATA + "wind-state.json";
const CONCURRENCY = 8;

async function readState(): Promise<Record<string, number>> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function samplePoint(tiff: GeoTIFF, lat: number, lon: number): Promise<number | null> {
  const image = await tiff.getImage();
  const [minX, minY, maxX, maxY] = image.getBoundingBox() as [number, number, number, number];
  const w = image.getWidth(), h = image.getHeight();
  const px = Math.floor(((lon - minX) / (maxX - minX)) * w);
  const py = Math.floor(((maxY - lat) / (maxY - minY)) * h);
  if (px < 1 || py < 1 || px >= w - 1 || py >= h - 1) return null;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const data = await image.readRasters({ window: [px - 1, py - 1, px + 2, py + 2] });
      const band = data[0] as Float32Array;
      const valid = Array.from(band).filter((v) => Number.isFinite(v) && v >= 0 && v < 60);
      if (!valid.length) return null;
      return valid.reduce((a, b) => a + b, 0) / valid.length;
    } catch {
      await new Promise((r) => setTimeout(r, 1_500 * (attempt + 1)));
    }
  }
  return null;
}

export async function enrichWind(limit?: number): Promise<void> {
  return withPlacesLock("enrich-wind", () => enrichWindUnlocked(limit));
}

async function enrichWindUnlocked(limit?: number): Promise<void> {
  const rows: PlaceRow[] = await readPlaces();
  const state = await readState();
  const todo = rows.filter((r) => !(r.slug in state)).slice(0, limit ?? Infinity);
  console.log(`wind: ${rows.length} places, ${Object.keys(state).length} done, ${todo.length} to process`);
  console.log(`wind: source Global Wind Atlas (DTU Wind Energy / World Bank ESMAP, CC-BY-4.0), ${GWA_URL}`);

  const tiff = await fromUrl(GWA_URL);

  let ok = 0, fail = 0, i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const row = todo[i++];
      if (!row) break;
      const v = await samplePoint(tiff, row.lat, row.lng);
      if (v != null) {
        state[row.slug] = Math.round(v * 10) / 10;
        ok++;
      } else {
        fail++;
      }
      const n = ok + fail;
      if (n % 200 === 0) {
        console.log(`wind: ${n}/${todo.length} (ok ${ok}, fail ${fail})`);
        await writeFile(STATE_FILE, JSON.stringify(state));
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  await writeFile(STATE_FILE, JSON.stringify(state));
  for (const r of rows) {
    const v = state[r.slug];
    if (v != null) r.attrs.windMs = v;
  }
  await writePlaces(rows);
  console.log(`wind done: ok ${ok}, fail ${fail} (rerun to retry the rest — state file skips done slugs)`);
  console.log(`wind: ${Object.keys(state).length}/${rows.length} places now have windMs`);
}
