import { readFile, writeFile, unlink } from "node:fs/promises";
import type { PlaceRow } from "./types.js";

/**
 * Shared read-modify-write path for data/places.json, used by every
 * enrich-*.ts stream. Centralized here so the lock (see withPlacesLock) is
 * applied consistently instead of each enricher rolling its own.
 */

const DATA = new URL("../data/", import.meta.url).pathname;
const PLACES_FILE = DATA + "places.json";
const LOCK_FILE = DATA + ".places.lock";

/** Read the full places.json dataset. */
export async function readPlaces(): Promise<PlaceRow[]> {
  return JSON.parse(await readFile(PLACES_FILE, "utf8"));
}

/** Overwrite places.json with the given rows. */
export async function writePlaces(rows: PlaceRow[]): Promise<void> {
  await writeFile(PLACES_FILE, JSON.stringify(rows));
}

/**
 * Work-loss guard: wrap a places.json read-modify-write step in a filesystem
 * lock so two enrich-*.ts runs never race writing the same file. Creates
 * data/.places.lock atomically at start (an `open(..., "wx")`, so the "does
 * it exist" check and the create can't race each other); if it's already
 * present, aborts immediately with a clear message instead of touching
 * places.json. Always removes the lock when `fn` settles (success or
 * throw) so a killed/erroring run doesn't wedge future runs.
 */
export async function withPlacesLock<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    await writeFile(LOCK_FILE, `${label} ${new Date().toISOString()}\n`, { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `${label}: another enricher is writing places.json (${LOCK_FILE} present) — run enrichers sequentially`,
      );
    }
    throw e;
  }
  try {
    return await fn();
  } finally {
    await unlink(LOCK_FILE).catch(() => {});
  }
}
