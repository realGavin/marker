import { readFile, writeFile } from "node:fs/promises";
import { fromFile, fromUrl, type GeoTIFF } from "geotiff";
import type { PlaceRow } from "./types.js";

/**
 * Environment/setting tags, each from a different free public raster or
 * vector source (see per-section comments for exact provenance). All are
 * merged into attrs.setting (deduped), never clobbering tags another stream
 * already wrote (e.g. enrich-par's "links").
 *
 * Ordering dependency: "mountain" and "windy" read data/elevation-state.json
 * and data/wind-state.json (written by enrich-elevation.ts / enrich-wind.ts)
 * — run those first. Courses missing that data simply don't get the tag,
 * silently, so this is safe to run before/without them.
 */

const DATA = new URL("../data/", import.meta.url).pathname;
const GEO = DATA + "geo/";

// ---- coastal: Natural Earth 10m coastline (public domain), cached locally ----
// https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_coastline.geojson
const COASTLINE_FILE = GEO + "ne_10m_coastline.geojson";
const COASTAL_RADIUS_M = 3_000;
const GRID_CELL_DEG = 0.05; // ~5.5km at the equator; 3x3 neighborhood covers the 3km radius with margin

interface Seg {
  lat1: number;
  lon1: number;
  lat2: number;
  lon2: number;
}

async function buildCoastGrid(): Promise<Map<string, Seg[]>> {
  const geo = JSON.parse(await readFile(COASTLINE_FILE, "utf8")) as {
    features: { geometry: { type: string; coordinates: unknown } }[];
  };
  const grid = new Map<string, Seg[]>();
  const insert = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const seg: Seg = { lat1, lon1, lat2, lon2 };
    const i0 = Math.floor(Math.min(lat1, lat2) / GRID_CELL_DEG);
    const i1 = Math.floor(Math.max(lat1, lat2) / GRID_CELL_DEG);
    const j0 = Math.floor(Math.min(lon1, lon2) / GRID_CELL_DEG);
    const j1 = Math.floor(Math.max(lon1, lon2) / GRID_CELL_DEG);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = `${i},${j}`;
        (grid.get(k) ?? grid.set(k, []).get(k)!).push(seg);
      }
    }
  };
  for (const f of geo.features) {
    const g = f.geometry;
    const lines = g.type === "LineString" ? [g.coordinates as [number, number][]] : (g.coordinates as [number, number][][]);
    for (const line of lines) {
      for (let i = 1; i < line.length; i++) {
        const [lon1, lat1] = line[i - 1]!;
        const [lon2, lat2] = line[i]!;
        insert(lat1!, lon1!, lat2!, lon2!);
      }
    }
  }
  return grid;
}

function distToSegM(lat: number, lon: number, seg: Seg): number {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const toXY = (la: number, lo: number): [number, number] => [(lo - lon) * 111_320 * cosLat, (la - lat) * 111_320];
  const [x1, y1] = toXY(seg.lat1, seg.lon1);
  const [x2, y2] = toXY(seg.lat2, seg.lon2);
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : (-x1 * dx + -y1 * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x1 + t * dx, y1 + t * dy);
}

function nearestCoastM(grid: Map<string, Seg[]>, lat: number, lon: number): number {
  const i = Math.floor(lat / GRID_CELL_DEG), j = Math.floor(lon / GRID_CELL_DEG);
  let best = Infinity;
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      const segs = grid.get(`${i + di},${j + dj}`);
      if (!segs) continue;
      for (const s of segs) {
        const d = distToSegM(lat, lon, s);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

// ---- desert: Beck et al. 2018 Koppen-Geiger 0.0083deg (CC-BY-4.0), cached locally ----
// https://figshare.com/articles/dataset/Present_and_future_K_ppen-Geiger_climate_classification_maps_at_1-km_resolution/6396959
// classes 4-7 = BWh/BWk/BSh/BSk (arid desert/steppe); see data/geo/koppen/legend.txt
const KOPPEN_FILE = GEO + "koppen/Beck_KG_V1_present_0p0083.tif";
const DESERT_CLASSES = new Set([4, 5, 6, 7]);
// US + territories bbox (CONUS + AK + HI), generous pad. One windowed read of
// this box (~100M px, ~100MB as Uint8Array) beats 12k+ tiny per-course reads
// of a local LZW-tiled TIFF — each of those pays a full tile-decode round
// trip, which measured ~10min+ for the full course set; this is seconds.
const US_BBOX = { minLat: 15, maxLat: 72, minLon: -180, maxLon: -64 };

interface KoppenGrid {
  data: Uint8Array;
  w: number;
  h: number;
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}

async function loadKoppenGrid(): Promise<KoppenGrid> {
  const tiff = await fromFile(KOPPEN_FILE);
  const image = await tiff.getImage();
  const [imgMinX, imgMinY, imgMaxX, imgMaxY] = image.getBoundingBox() as [number, number, number, number];
  const fullW = image.getWidth(), fullH = image.getHeight();
  const lonToPx = (lon: number) => Math.round(((lon - imgMinX) / (imgMaxX - imgMinX)) * fullW);
  const latToPy = (lat: number) => Math.round(((imgMaxY - lat) / (imgMaxY - imgMinY)) * fullH);
  const px0 = Math.max(0, lonToPx(US_BBOX.minLon));
  const px1 = Math.min(fullW, lonToPx(US_BBOX.maxLon));
  const py0 = Math.max(0, latToPy(US_BBOX.maxLat));
  const py1 = Math.min(fullH, latToPy(US_BBOX.minLat));
  const data = (await image.readRasters({ window: [px0, py0, px1, py1] }))[0] as Uint8Array;
  return {
    data,
    w: px1 - px0,
    h: py1 - py0,
    minLon: US_BBOX.minLon,
    maxLon: US_BBOX.maxLon,
    minLat: US_BBOX.minLat,
    maxLat: US_BBOX.maxLat,
  };
}

function koppenClassAt(grid: KoppenGrid, lat: number, lon: number): number | null {
  const px = Math.floor(((lon - grid.minLon) / (grid.maxLon - grid.minLon)) * grid.w);
  const py = Math.floor(((grid.maxLat - lat) / (grid.maxLat - grid.minLat)) * grid.h);
  if (px < 0 || py < 0 || px >= grid.w || py >= grid.h) return null;
  return grid.data[py * grid.w + px] ?? null;
}

// ---- wooded/open: ESA WorldCover 2021 10m (CC-BY-4.0), remote HTTP range reads ----
// https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ (public bucket, no auth)
const WORLDCOVER_BASE = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/";
const TREE_COVER_CLASS = 10;
const HALF_WINDOW_M = 600; // ±600m around centroid, per spec
const WOODED_FRACTION = 0.4;
const OPEN_FRACTION = 0.15;
const WORLDCOVER_STATE_FILE = DATA + "worldcover-state.json";

function worldcoverTileName(lat: number, lon: number): string {
  const latFloor = Math.floor(lat / 3) * 3;
  const lonFloor = Math.floor(lon / 3) * 3;
  const ns = latFloor >= 0 ? `N${String(latFloor).padStart(2, "0")}` : `S${String(-latFloor).padStart(2, "0")}`;
  const ew = lonFloor >= 0 ? `E${String(lonFloor).padStart(3, "0")}` : `W${String(-lonFloor).padStart(3, "0")}`;
  return `${ns}${ew}`;
}

const tileCache = new Map<string, GeoTIFF | "unavailable">();
async function getTile(tileName: string): Promise<GeoTIFF | null> {
  const cached = tileCache.get(tileName);
  if (cached === "unavailable") return null;
  if (cached) return cached;
  try {
    const tiff = await fromUrl(`${WORLDCOVER_BASE}ESA_WorldCover_10m_2021_v200_${tileName}_Map.tif`);
    tileCache.set(tileName, tiff);
    return tiff;
  } catch {
    tileCache.set(tileName, "unavailable");
    return null;
  }
}

/**
 * Tree-cover fraction over the full ±600m window around the centroid (a
 * single ranged read of the whole small window, ~120x120 10m pixels — more
 * accurate than a sparse 5x5 point sample and needs only one HTTP request
 * per course instead of 25).
 */
async function treeFractionAt(lat: number, lon: number): Promise<number | null> {
  const tileName = worldcoverTileName(lat, lon);
  const tiff = await getTile(tileName);
  if (!tiff) return null;
  const image = await tiff.getImage();
  const [minX, minY, maxX, maxY] = image.getBoundingBox() as [number, number, number, number];
  const w = image.getWidth(), h = image.getHeight();
  const dLat = HALF_WINDOW_M / 111_320;
  const dLon = HALF_WINDOW_M / (111_320 * Math.cos((lat * Math.PI) / 180));
  const px0 = Math.floor(((lon - dLon - minX) / (maxX - minX)) * w);
  const px1 = Math.ceil(((lon + dLon - minX) / (maxX - minX)) * w);
  const py0 = Math.floor(((maxY - (lat + dLat)) / (maxY - minY)) * h);
  const py1 = Math.ceil(((maxY - (lat - dLat)) / (maxY - minY)) * h);
  if (px0 < 0 || py0 < 0 || px1 > w || py1 > h || px1 <= px0 || py1 <= py0) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await image.readRasters({ window: [px0, py0, px1, py1] });
      const band = data[0] as Uint8Array;
      if (!band.length) return null;
      let trees = 0;
      for (const v of band) if (v === TREE_COVER_CLASS) trees++;
      return trees / band.length;
    } catch {
      await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)));
    }
  }
  return null;
}

function mergeSetting(r: PlaceRow, tag: string): void {
  const set = new Set(r.attrs.setting ?? []);
  if (!set.has(tag)) {
    set.add(tag);
    r.attrs.setting = [...set];
  }
}

interface ElevEntry {
  range: number;
  centroid: number;
}

export async function enrichSetting(woodedOpenLimit?: number): Promise<void> {
  const rows: PlaceRow[] = JSON.parse(await readFile(DATA + "places.json", "utf8"));

  // ---- fast, local-only tags: coastal, desert, mountain, windy ----
  console.log("enrich-setting: building coastline grid index...");
  const coastGrid = await buildCoastGrid();
  console.log(`enrich-setting: coastline grid ready (${coastGrid.size} cells)`);

  console.log("enrich-setting: loading Koppen-Geiger raster (US bbox)...");
  const kgGrid = await loadKoppenGrid();
  console.log(`enrich-setting: Koppen-Geiger grid ready (${kgGrid.w}x${kgGrid.h}px)`);

  let elevState: Record<string, ElevEntry> = {};
  try {
    elevState = JSON.parse(await readFile(DATA + "elevation-state.json", "utf8"));
  } catch {
    console.log("enrich-setting: no elevation-state.json yet — mountain tag skipped for all courses");
  }
  let windState: Record<string, number> = {};
  try {
    windState = JSON.parse(await readFile(DATA + "wind-state.json", "utf8"));
  } catch {
    console.log("enrich-setting: no wind-state.json yet — windy tag skipped for all courses");
  }

  let coastal = 0, desert = 0, mountain = 0, windy = 0;
  for (const r of rows) {
    if (nearestCoastM(coastGrid, r.lat, r.lng) < COASTAL_RADIUS_M) {
      mergeSetting(r, "coastal");
      coastal++;
    }
    const kg = koppenClassAt(kgGrid, r.lat, r.lng);
    if (kg != null && DESERT_CLASSES.has(kg)) {
      mergeSetting(r, "desert");
      desert++;
    }
    const elev = elevState[r.slug];
    if (elev && (elev.range > 60 || elev.centroid > 1500)) {
      mergeSetting(r, "mountain");
      mountain++;
    }
    const wind = windState[r.slug];
    if (wind != null && wind > 6) {
      mergeSetting(r, "windy");
      windy++;
    }
  }
  await writeFile(DATA + "places.json", JSON.stringify(rows));
  console.log(
    `enrich-setting: coastal ${coastal}, desert ${desert}, mountain ${mountain} (of ${Object.keys(elevState).length} w/ elevation), ` +
      `windy ${windy} (of ${Object.keys(windState).length} w/ wind)`,
  );

  // ---- slow, remote-range-read tags: wooded/open ----
  let wcState: Record<string, { wooded: boolean; open: boolean }> = {};
  try {
    wcState = JSON.parse(await readFile(WORLDCOVER_STATE_FILE, "utf8"));
  } catch {
    /* first run */
  }
  const todo = rows.filter((r) => !(r.slug in wcState)).slice(0, woodedOpenLimit ?? Infinity);
  console.log(`enrich-setting: wooded/open — ${Object.keys(wcState).length} done, ${todo.length} to process`);

  let ok = 0, fail = 0, consecutiveFail = 0, aborted = false, i = 0;
  const CONCURRENCY = 6;
  const worker = async () => {
    while (i < todo.length && !aborted) {
      const row = todo[i++];
      if (!row) break;
      const frac = await treeFractionAt(row.lat, row.lng);
      if (frac == null) {
        fail++;
        consecutiveFail++;
        if (consecutiveFail >= 15 && ok === 0) {
          console.log("enrich-setting: WorldCover range-read plumbing looks unreliable (15 consecutive failures, 0 successes) — aborting wooded/open for this run, leaving it for a rerun");
          aborted = true;
        }
        continue;
      }
      consecutiveFail = 0;
      const wooded = frac > WOODED_FRACTION;
      const open = frac < OPEN_FRACTION;
      wcState[row.slug] = { wooded, open };
      if (wooded) mergeSetting(row, "wooded");
      if (open) mergeSetting(row, "open");
      ok++;
      const n = ok + fail;
      if (n % 200 === 0) {
        console.log(`enrich-setting: wooded/open ${n}/${todo.length} (ok ${ok}, fail ${fail})`);
        await writeFile(WORLDCOVER_STATE_FILE, JSON.stringify(wcState));
        await writeFile(DATA + "places.json", JSON.stringify(rows));
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  await writeFile(WORLDCOVER_STATE_FILE, JSON.stringify(wcState));
  await writeFile(DATA + "places.json", JSON.stringify(rows));
  const woodedCount = Object.values(wcState).filter((v) => v.wooded).length;
  const openCount = Object.values(wcState).filter((v) => v.open).length;
  console.log(
    `enrich-setting: wooded/open done — ok ${ok}, fail ${fail}${aborted ? " (aborted early)" : ""}; ` +
      `${woodedCount} wooded, ${openCount} open of ${Object.keys(wcState).length} sampled`,
  );
}
