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

/**
 * The 1st of `month` (1-12), local time, at its nearest coming occurrence —
 * this year if that date hasn't passed yet, next year otherwise. Turns a
 * decline's playable-window month into a concrete date to prefill, so "Try
 * April to October" always lands on a future April, never a stale one.
 */
export function nextMonthStart(month: number): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let d = new Date(now.getFullYear(), month - 1, 1);
  if (d.getTime() < today.getTime()) d = new Date(now.getFullYear() + 1, month - 1, 1);
  return localDateString(d);
}
