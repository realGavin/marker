import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import type { PlaceRow } from "./types.js";
import { readPlaces, writePlaces, withPlacesLock } from "./places-io.js";

/**
 * Playable-season enrichment from NOAA/NCEI 1991-2020 U.S. Climate Normals
 * (public domain): monthly TMAX normals by-variable bulk file + the GHCN
 * station inventory (for lat/lon), both cached in data/geo/.
 *   temps: https://www.ncei.noaa.gov/data/normals-monthly/1991-2020/archive/us-climate-normals_1991-2020_v1.0.1_monthly_temperature_by-variable_c20230403.tar.gz
 *   stations: https://www.ncei.noaa.gov/data/normals-monthly/1991-2020/doc/inventory_30yr.txt
 * A month is "playable" when the station's average high (MLY-TMAX-NORMAL,
 * degF) falls between 7C and 38C. attrs.seasonMonths is the longest
 * contiguous run of playable months (wrap allowed, e.g. [10,5]); if every
 * month is playable we write [1,12]; if none are, we omit the field.
 * Matches each course to the nearest station within 80km.
 */

const DATA = new URL("../data/", import.meta.url).pathname;
const GEO = DATA + "geo/";
const TEMP_TAR_URL =
  "https://www.ncei.noaa.gov/data/normals-monthly/1991-2020/archive/us-climate-normals_1991-2020_v1.0.1_monthly_temperature_by-variable_c20230403.tar.gz";
const INVENTORY_URL = "https://www.ncei.noaa.gov/data/normals-monthly/1991-2020/doc/inventory_30yr.txt";
const NORMAL_CSV = "mly-normal-allall.csv";
const INVENTORY_FILE = GEO + "noaa-inventory_30yr.txt";
const NORMAL_CSV_FILE = GEO + `noaa-${NORMAL_CSV}`;

const MAX_STATION_DIST_M = 80_000;
const PLAYABLE_MIN_F = (7 * 9) / 5 + 32; // 7C
const PLAYABLE_MAX_F = (38 * 9) / 5 + 32; // 38C

async function exists(f: string): Promise<boolean> {
  return access(f).then(() => true, () => false);
}

async function ensureCached(): Promise<void> {
  await mkdir(GEO, { recursive: true });
  if (!(await exists(INVENTORY_FILE))) {
    const res = await fetch(INVENTORY_URL, { headers: { "User-Agent": "marker-etl/0.1 (golf place directory seeding; contact shuozeng21@gmail.com)" } });
    if (!res.ok) throw new Error(`inventory fetch failed: HTTP ${res.status}`);
    await writeFile(INVENTORY_FILE, Buffer.from(await res.arrayBuffer()));
    console.log("enrich-season: cached station inventory");
  }
  if (!(await exists(NORMAL_CSV_FILE))) {
    const res = await fetch(TEMP_TAR_URL, { headers: { "User-Agent": "marker-etl/0.1 (golf place directory seeding; contact shuozeng21@gmail.com)" } });
    if (!res.ok) throw new Error(`normals tar fetch failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const csv = await extractFromTarGz(buf, NORMAL_CSV);
    if (!csv) throw new Error(`${NORMAL_CSV} not found in normals tar`);
    await writeFile(NORMAL_CSV_FILE, csv);
    console.log("enrich-season: cached monthly normals (temperature)");
  }
}

/** Minimal tar reader (no deps): gunzip, then walk 512-byte tar headers to find one member by name. */
async function extractFromTarGz(gz: Buffer, memberName: string): Promise<Buffer | null> {
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const gunzip = createGunzip();
    Readable.from(gz).pipe(gunzip);
    gunzip.on("data", (c) => chunks.push(c));
    gunzip.on("end", () => resolve(Buffer.concat(chunks)));
    gunzip.on("error", reject);
  });
  let offset = 0;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive padding
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeOctal = header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeOctal, 8) || 0;
    const dataStart = offset + 512;
    if (name === memberName) return raw.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

interface Station {
  id: string;
  lat: number;
  lon: number;
}

function parseInventory(text: string): Station[] {
  const out: Station[] = [];
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const [id, latS, lonS] = parts;
    const lat = Number.parseFloat(latS!), lon = Number.parseFloat(lonS!);
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    out.push({ id, lat, lon });
  }
  return out;
}

/** stationId -> [tmaxF for month 1..12] */
function parseTmaxNormals(csv: string): Map<string, (number | null)[]> {
  const lines = csv.split("\n");
  const header = lines[0]!.split(",");
  const idIdx = header.indexOf("GHCN_ID");
  const monthIdx = header.indexOf("month");
  const tmaxIdx = header.indexOf("MLY-TMAX-NORMAL");
  const out = new Map<string, (number | null)[]>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const cols = line.split(",");
    const id = cols[idIdx]?.replace(/"/g, "");
    const month = Number.parseInt(cols[monthIdx]?.replace(/"/g, "") ?? "", 10);
    const tmax = Number.parseFloat(cols[tmaxIdx]?.replace(/"/g, "") ?? "");
    if (!id || !Number.isFinite(month) || month < 1 || month > 12) continue;
    const arr = out.get(id) ?? out.set(id, new Array(12).fill(null)).get(id)!;
    arr[month - 1] = Number.isFinite(tmax) ? tmax : null;
  }
  return out;
}

/** Longest contiguous run (wrap allowed) of true values in a 12-length array. */
function longestRun(playable: boolean[]): [number, number] | null {
  if (playable.every(Boolean)) return [1, 12];
  if (!playable.some(Boolean)) return null;
  let bestLen = 0, bestStart = 0;
  for (let start = 0; start < 12; start++) {
    if (!playable[start]) continue;
    let len = 0;
    for (let k = 0; k < 12; k++) {
      if (playable[(start + k) % 12]) len++;
      else break;
    }
    if (len > bestLen) {
      bestLen = len;
      bestStart = start;
    }
  }
  const end = ((bestStart + bestLen - 1) % 12) + 1;
  return [bestStart + 1, end];
}

export async function enrichSeason(): Promise<void> {
  return withPlacesLock("enrich-season", () => enrichSeasonUnlocked());
}

async function enrichSeasonUnlocked(): Promise<void> {
  await ensureCached();
  const rows: PlaceRow[] = await readPlaces();
  const stations = parseInventory(await readFile(INVENTORY_FILE, "utf8"));
  const tmaxByStation = parseTmaxNormals(await readFile(NORMAL_CSV_FILE, "utf8"));
  const usable = stations.filter((s) => tmaxByStation.has(s.id));
  console.log(`enrich-season: ${usable.length}/${stations.length} inventory stations have TMAX normals`);

  let matched = 0, written = 0, allYear = 0, noneMatched = 0;
  for (const r of rows) {
    const cosLat = Math.cos((r.lat * Math.PI) / 180);
    let best: Station | null = null;
    let bestD2 = Infinity;
    for (const s of usable) {
      const d2 = (s.lat - r.lat) ** 2 + ((s.lon - r.lng) * cosLat) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = s;
      }
    }
    if (!best || Math.sqrt(bestD2) * 111_320 > MAX_STATION_DIST_M) {
      noneMatched++;
      continue;
    }
    matched++;
    const tmax = tmaxByStation.get(best.id)!;
    const playable = tmax.map((f) => f != null && f >= PLAYABLE_MIN_F && f <= PLAYABLE_MAX_F);
    const run = longestRun(playable);
    if (!run) continue;
    r.attrs.seasonMonths = run;
    written++;
    if (run[0] === 1 && run[1] === 12) allYear++;
  }

  await writePlaces(rows);
  console.log(
    `enrich-season: ${matched}/${rows.length} matched a station within ${MAX_STATION_DIST_M / 1000}km ` +
      `(${noneMatched} unmatched — sparse station coverage), ${written} got seasonMonths (${allYear} year-round)`,
  );
}
