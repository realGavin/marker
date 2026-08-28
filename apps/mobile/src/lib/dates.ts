/** Small date helpers shared by the trip planner, its editor, and the brief form. */

/** YYYY-MM-DD in local time (Date#toISOString is UTC and shifts the day for non-UTC users). */
export function localDateString(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Date for a given 1-based trip day, from the trip's start date. */
export function dayDate(startDate: string | null | undefined, day: number): string | null {
  if (!startDate) return null;
  const d = new Date(startDate + "T12:00:00");
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + (day - 1));
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
