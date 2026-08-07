import { readFile, writeFile } from "node:fs/promises";
import type { PlaceRow } from "./types.js";

const DATA = new URL("../data/", import.meta.url).pathname;

/** Coverage report for the Course Intelligence Pack streams (par, length, elevation, wind, setting, season, wikidata). */
export async function reportIntel(): Promise<void> {
  const rows: PlaceRow[] = JSON.parse(await readFile(DATA + "places.json", "utf8"));
  const n = rows.length;
  const pct = (count: number) => ((count / n) * 100).toFixed(1) + "%";

  let par = 0, lengthYds = 0, elevRangeM = 0, windMs = 0, seasonMonths = 0, designer = 0, yearOpened = 0;
  const settingCounts = new Map<string, number>();
  for (const r of rows) {
    if (r.attrs.par != null) par++;
    if (r.attrs.lengthYds != null) lengthYds++;
    if (r.attrs.elevRangeM != null) elevRangeM++;
    if (r.attrs.windMs != null) windMs++;
    if (r.attrs.seasonMonths != null) seasonMonths++;
    if (r.attrs.designer != null) designer++;
    if (r.attrs.yearOpened != null) yearOpened++;
    for (const tag of r.attrs.setting ?? []) settingCounts.set(tag, (settingCounts.get(tag) ?? 0) + 1);
  }

  const settingLines = [...settingCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => `  ${tag}: ${count} (${pct(count)})`);

  const lines = [
    `# Course Intelligence Pack coverage — ${new Date().toISOString().slice(0, 10)}`,
    ``,
    `Total courses: ${n}`,
    ``,
    `par: ${par} (${pct(par)})`,
    `lengthYds: ${lengthYds} (${pct(lengthYds)})`,
    `elevRangeM: ${elevRangeM} (${pct(elevRangeM)})`,
    `windMs: ${windMs} (${pct(windMs)})`,
    `seasonMonths: ${seasonMonths} (${pct(seasonMonths)})`,
    `designer: ${designer} (${pct(designer)})`,
    `yearOpened (wikidata-filled or explicit): ${yearOpened} (${pct(yearOpened)})`,
    ``,
    `setting tags:`,
    ...(settingLines.length ? settingLines : ["  (none yet)"]),
  ];
  const text = lines.join("\n");
  await writeFile(DATA + "report-intel.md", text);
  console.log(text);
}
