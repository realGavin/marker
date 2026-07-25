import { readFile, writeFile } from "node:fs/promises";
import type { PlaceRow } from "./types.js";
import { slugify } from "./transform.js";

const DATA = new URL("../data/", import.meta.url).pathname;
const GT = new URL("../ground-truth.json", import.meta.url).pathname;

const tokens = (s: string) =>
  new Set(
    slugify(s)
      .split("-")
      .filter((t) => t && !["golf", "course", "club", "country", "the", "links", "at", "park"].includes(t)),
  );

function matches(gtName: string, row: PlaceRow): boolean {
  const g = tokens(gtName);
  // names made entirely of stopwords ("The Country Club") compare as full slugs
  if (g.size === 0) return slugify(gtName) === slugify(row.name);
  const r = tokens(row.name);
  let hit = 0;
  for (const t of g) if (r.has(t)) hit++;
  return hit / g.size >= 0.6;
}

export async function report(): Promise<void> {
  const rows: PlaceRow[] = JSON.parse(await readFile(DATA + "places.json", "utf8"));
  const gt = JSON.parse(await readFile(GT, "utf8")).courses as Array<{ name: string; state: string }>;

  const byState: Record<string, number> = {};
  let withHoles = 0, withWebsite = 0, withCity = 0, knownAccess = 0;
  for (const r of rows) {
    byState[r.region!] = (byState[r.region!] ?? 0) + 1;
    if (r.attrs.holes) withHoles++;
    if (r.attrs.website) withWebsite++;
    if (r.city) withCity++;
    if (r.attrs.access && r.attrs.access !== "unknown") knownAccess++;
  }

  const missed: string[] = [];
  for (const g of gt) {
    const found = rows.some((r) => r.region === g.state && matches(g.name, r));
    if (!found) missed.push(`${g.name} (${g.state})`);
  }
  const hitRate = ((gt.length - missed.length) / gt.length) * 100;

  const pct = (n: number) => ((n / rows.length) * 100).toFixed(1) + "%";
  const lines = [
    `# Data quality report — ${new Date().toISOString().slice(0, 10)}`,
    ``,
    `Total courses: ${rows.length}`,
    `States covered: ${Object.keys(byState).length}`,
    `Ground truth: ${gt.length - missed.length}/${gt.length} matched (${hitRate.toFixed(1)}%) — DoD needs >=95%`,
    missed.length ? `Missed: ${missed.join("; ")}` : `Missed: none`,
    ``,
    `Field coverage: holes ${pct(withHoles)} | website ${pct(withWebsite)} | city ${pct(withCity)} | access known ${pct(knownAccess)}`,
    ``,
    `Top 10 states: ` +
      Object.entries(byState).sort((a, b) => b[1] - a[1]).slice(0, 10)
        .map(([s, n]) => `${s}:${n}`).join(" "),
  ];
  const text = lines.join("\n");
  await writeFile(DATA + "report.md", text);
  console.log(text);
  if (hitRate < 95) process.exitCode = 1;
}
