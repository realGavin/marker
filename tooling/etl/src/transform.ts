import { writeFile, mkdir } from "node:fs/promises";
import type { OsmElement, PlaceRow } from "./types.js";
import { readRaw } from "./extract.js";

const OUT_DIR = new URL("../data/", import.meta.url).pathname;

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function accessOf(tags: Record<string, string>): PlaceRow["attrs"]["access"] {
  const a = tags["access"] ?? "";
  const ownership = tags["ownership"] ?? tags["operator:type"] ?? "";
  if (tags["golf_course:type"] === "municipal" || /municipal|public_authority|government/.test(ownership)) return "municipal";
  if (a === "private" || tags["membership"] === "required") return "private";
  if (a === "customers") return "semi-private";
  if (a === "yes" || a === "permissive" || a === "public") return "public";
  if (/resort/i.test(tags["name"] ?? "")) return "resort";
  return "unknown";
}

function toRow(el: OsmElement, state: string): PlaceRow | null {
  const tags = el.tags ?? {};
  const name = tags["name"]?.trim();
  const lat = el.lat ?? el.center?.lat;
  const lng = el.lon ?? el.center?.lon;
  // unnamed or geometry-less features are unusable for a directory
  if (!name || lat == null || lng == null) return null;
  // driving ranges / minigolf sometimes mistagged. NB: match "footgolf" only as
  // one word — "foot.?golf" famously nukes "Winged Foot Golf Club".
  if (/driving range|mini.?golf|\bfootgolf\b/i.test(name) || tags["sport"] === "miniature_golf") return null;

  const holes = Number.parseInt(tags["holes"] ?? "", 10);
  const par = Number.parseInt(tags["par"] ?? "", 10);
  const year = Number.parseInt(tags["start_date"]?.slice(0, 4) ?? "", 10);
  const website = tags["website"] ?? tags["contact:website"];

  return {
    niche_id: "golf",
    slug: "", // assigned after dedupe
    name,
    lat: +lat.toFixed(6),
    lng: +lng.toFixed(6),
    city: tags["addr:city"]?.trim() || null,
    region: state,
    country: "US",
    attrs: {
      ...(holes >= 1 && holes <= 45 ? { holes } : {}),
      ...(par >= 27 && par <= 80 ? { par } : {}),
      access: accessOf(tags),
      ...(website ? { website: website.split(";")[0]!.trim().slice(0, 500) } : {}),
      ...(year >= 1700 && year <= 2100 ? { yearOpened: year } : {}),
    },
    source: "osm",
    source_ref: `${el.type}/${el.id}`,
  };
}

const kmBetween = (a: PlaceRow, b: PlaceRow) => {
  const dLat = (a.lat - b.lat) * 111.32;
  const dLng = (a.lng - b.lng) * 111.32 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
};

const normName = (s: string) =>
  slugify(s).replace(/-(golf|country|club|course|links|the)\b/g, "").replace(/--+/g, "-");

/**
 * Dedupe: same normalized name within 2km → keep the richer row (a course is
 * often mapped both as a way and a relation, or split into two 9-hole ways).
 */
export function dedupe(rows: PlaceRow[]): { rows: PlaceRow[]; removed: number } {
  const byName = new Map<string, PlaceRow[]>();
  for (const r of rows) {
    const k = `${r.region}:${normName(r.name)}`;
    (byName.get(k) ?? byName.set(k, []).get(k)!).push(r);
  }
  const out: PlaceRow[] = [];
  let removed = 0;
  const richness = (r: PlaceRow) => Object.keys(r.attrs).length + (r.city ? 1 : 0) + (r.source_ref.startsWith("relation") ? 0.5 : 0);
  for (const group of byName.values()) {
    const kept: PlaceRow[] = [];
    for (const r of group.sort((a, b) => richness(b) - richness(a))) {
      if (kept.some((k) => kmBetween(k, r) < 2)) removed++;
      else kept.push(r);
    }
    out.push(...kept);
  }
  return { rows: out, removed };
}

/** Assign deterministic unique slugs: name, then name + city, then name + osm ref. */
export function assignSlugs(rows: PlaceRow[]): void {
  const used = new Map<string, PlaceRow>();
  for (const r of rows.sort((a, b) => a.source_ref.localeCompare(b.source_ref))) {
    const base = `${slugify(r.name)}-${r.region!.toLowerCase()}`;
    let slug = base;
    if (used.has(slug) && r.city) slug = `${base}-${slugify(r.city)}`;
    if (used.has(slug)) slug = `${base}-${r.source_ref.replace("/", "")}`;
    used.set(slug, r);
    r.slug = slug;
  }
}

async function readSupplement(): Promise<PlaceRow[]> {
  const { readFile } = await import("node:fs/promises");
  const file = new URL("../supplement.json", import.meta.url).pathname;
  const { courses } = JSON.parse(await readFile(file, "utf8"));
  return courses.map((c: { name: string; state: string; city?: string; lat: number; lng: number; attrs?: PlaceRow["attrs"] }): PlaceRow => ({
    niche_id: "golf",
    slug: "",
    name: c.name,
    lat: c.lat,
    lng: c.lng,
    city: c.city ?? null,
    region: c.state,
    country: "US",
    attrs: c.attrs ?? {},
    source: "manual",
    source_ref: `manual/${slugify(c.name)}`,
  }));
}

export async function transform(): Promise<PlaceRow[]> {
  const raw = await readRaw();
  if (raw.size === 0) throw new Error("no raw data — run extract first");
  const all: PlaceRow[] = await readSupplement();
  const perState: Record<string, number> = {};
  for (const [state, elements] of raw) {
    const rows = elements.map((e) => toRow(e, state)).filter((r): r is PlaceRow => r !== null);
    perState[state] = rows.length;
    all.push(...rows);
  }
  const { rows, removed } = dedupe(all);
  assignSlugs(rows);
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_DIR + "places.json", JSON.stringify(rows, null, 1));
  console.log(`transform: ${all.length} named courses → ${rows.length} after dedupe (${removed} merged)`);
  return rows;
}
