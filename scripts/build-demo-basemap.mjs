#!/usr/bin/env node
/**
 * Build docs/demo-states.json — the state outlines the demo map draws under
 * the course dots.
 *
 * Source is us-atlas (ISC), which repackages the US Census Bureau's
 * cartographic boundary files (public domain) as TopoJSON:
 *
 *   curl -o states-10m.json https://cdn.jsdelivr.net/npm/us-atlas@3.0.1/states-10m.json
 *   node scripts/build-demo-basemap.mjs states-10m.json
 *
 * Why not ship the TopoJSON as-is: it carries all 56 FIPS entries including
 * the territories, quantises to a grid far finer than a 1000px canvas can
 * show, and would make the page depend on a topojson-client decode at runtime.
 * This emits exactly what the canvas needs and nothing else.
 *
 * TOPOLOGY IS THE POINT. Simplifying whole polygons independently tears shared
 * borders apart — Nevada's eastern edge and Utah's western edge are the same
 * line, and two independent simplifications of it disagree, leaving slivers.
 * TopoJSON stores that line once as an "arc", so simplifying arcs keeps
 * neighbours welded together. It also means a border can be drawn once rather
 * than twice, which matters at hairline weights where a double stroke reads as
 * a heavier line.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

const src = process.argv[2];
const out = resolve(process.argv[3] || resolve(REPO, "docs/demo-states.json"));
if (!src) {
  console.error("usage: node scripts/build-demo-basemap.mjs <states-10m.json> [out.json]");
  process.exit(1);
}

/* Roughly half a device pixel at the width this map is drawn at: the conus
   spans ~58 degrees of longitude across ~1000 CSS px, so one degree is ~17px,
   and at dpr 2 a 0.015 degree deviation is about half a physical pixel. Below
   that the detail is real but invisible, and it is most of the file. */
const TOLERANCE = 0.015;
/* One degree is ~17px here, so 0.01 degree is under a fifth of a pixel even
   at dpr 2. Three decimals stored a precision the canvas cannot resolve and
   cost a third of the file to do it. */
const PRECISION = 2;

/* FIPS 60/66/69/72/78 are American Samoa, Guam, the Northern Marianas, Puerto
   Rico and the US Virgin Islands. The course directory covers the 50 states
   and DC, so drawing the territories would show five outlines that can never
   contain a dot. */
const TERRITORY = (id) => Number(id) > 56;
const GROUP_OF = (id) => (id === "02" ? "AK" : id === "15" ? "HI" : "conus");

const topo = JSON.parse(readFileSync(resolve(src), "utf8"));
if (topo.type !== "Topology" || !topo.objects?.states) {
  throw new Error("not a us-atlas states topology");
}

/* ---- decode: delta-encoded integers in a quantised grid -> lon/lat ---- */
const { scale: [sx, sy], translate: [tx, ty] } = topo.transform;
const arcs = topo.arcs.map((deltas) => {
  let x = 0, y = 0;
  const ring = [];
  for (const [dx, dy] of deltas) {
    x += dx; y += dy;
    ring.push([x * sx + tx, y * sy + ty]);
  }
  return ring;
});

/* ---- Douglas-Peucker, iterative so a 10k-point coastline cannot blow the
       stack. Endpoints are always kept, which is what welds arcs together. ---- */
function simplify(points, tol) {
  const n = points.length;
  if (n < 3) return points.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    if (hi - lo < 2) continue;
    const [ax, ay] = points[lo], [bx, by] = points[hi];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let far = -1, best = tol;
    for (let i = lo + 1; i < hi; i++) {
      const [px, py] = points[i];
      let d;
      if (len2 === 0) {
        d = Math.hypot(px - ax, py - ay);
      } else {
        // perpendicular distance from p to the segment a-b
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > best) { best = d; far = i; }
    }
    if (far !== -1) {
      keep[far] = 1;
      stack.push([lo, far], [far, hi]);
    }
  }
  const outPts = [];
  for (let i = 0; i < n; i++) if (keep[i]) outPts.push(points[i]);
  return outPts;
}

const round = (v) => Number(v.toFixed(PRECISION));
const simplified = arcs.map((a) => simplify(a, TOLERANCE));

/* The Aleutians cross the antimeridian and come back at +179.77, so Alaska's
   raw longitude span is 359 degrees and any projection or bounding box built
   from it is nonsense. Shifting the eastern hemisphere part to -180.23 makes
   the chain continue westward as it does on the ground. The renderer applies
   the same shift to Alaskan course coordinates so dots and outlines agree. */
const unwrapAlaska = (lon) => (lon > 0 ? lon - 360 : lon);

/* Even unwrapped, the far Aleutians run to -187 and give Alaska a 57-degree
   span against 20 degrees of latitude, so fitting that box into a square inset
   flattens the mainland to a smear. Dropping the islands west of here leaves
   Alaska almost square in Albers, which is close to its true proportions.
   Nothing is lost: the westernmost Alaskan course in the directory is at
   -162.7, on the Alaska Peninsula, and these are whole separate islands rather
   than a cut through any landmass. */
const AK_WEST_LIMIT = -170;

/* ---- walk the geometries, keeping TopoJSON's signed arc references ----
   A ring is a list of arc indices; a negative index i means arc ~i traversed
   backwards. Keeping that encoding is what lets the renderer draw each border
   once instead of once per state that touches it. */
const groups = {
  conus: { polys: [], used: new Map() },
  AK: { polys: [], used: new Map() },
  HI: { polys: [], used: new Map() }
};

// Easternmost longitude a polygon reaches, in the group's own frame.
function polyMaxLon(poly, unwrap) {
  let max = -Infinity;
  for (const ring of poly) {
    for (const idx of ring) {
      for (const [lon] of simplified[idx < 0 ? ~idx : idx]) {
        const v = unwrap ? unwrapAlaska(lon) : lon;
        if (v > max) max = v;
      }
    }
  }
  return max;
}

let kept = 0, dropped = 0;
for (const geom of topo.objects.states.geometries) {
  if (TERRITORY(geom.id)) continue;
  kept++;
  const key = GROUP_OF(geom.id);
  const g = groups[key];
  const polys = geom.type === "Polygon" ? [geom.arcs] : geom.arcs;
  for (const poly of polys) {
    if (key === "AK" && polyMaxLon(poly, true) < AK_WEST_LIMIT) { dropped++; continue; }
    g.polys.push(poly);
    for (const ring of poly) {
      for (const idx of ring) {
        const abs = idx < 0 ? ~idx : idx;
        g.used.set(abs, (g.used.get(abs) || 0) + 1);
      }
    }
  }
}

/* ---- emit only the arcs each group actually references, renumbered ---- */
const outGroups = {};
let totalPts = 0;
for (const [key, g] of Object.entries(groups)) {
  const ids = [...g.used.keys()].sort((a, b) => a - b);
  const remap = new Map(ids.map((id, i) => [id, i]));
  const arcsOut = ids.map((id) => {
    const pts = simplified[id];
    // Rounding can land neighbouring points on the same coordinate; those
    // segments have nothing to draw. Endpoints are kept whatever happens,
    // because they are the joins to the adjoining arcs.
    const flat = [];
    for (let i = 0; i < pts.length; i++) {
      const x = round(key === "AK" ? unwrapAlaska(pts[i][0]) : pts[i][0]);
      const y = round(pts[i][1]);
      const n = flat.length;
      const dup = n >= 2 && flat[n - 2] === x && flat[n - 1] === y;
      if (dup && i !== pts.length - 1) continue;
      if (dup && n >= 4) { flat[n - 2] = x; flat[n - 1] = y; continue; }
      flat.push(x, y);
    }
    totalPts += flat.length / 2;
    return flat;
  });
  const sign = (idx) => (idx < 0 ? ~remap.get(~idx) : remap.get(idx));
  outGroups[key] = {
    arcs: arcsOut,
    polys: g.polys.map((poly) => poly.map((ring) => ring.map(sign))),
    // An arc touched by one state is coastline or national border; one touched
    // by two is a state line between them. They are drawn at different weights.
    outer: ids.filter((id) => g.used.get(id) === 1).map((id) => remap.get(id)),
    inner: ids.filter((id) => g.used.get(id) > 1).map((id) => remap.get(id))
  };
}

const payload = {
  note: "US state outlines for the demo map. Built by scripts/build-demo-basemap.mjs from us-atlas (US Census Bureau cartographic boundaries, public domain).",
  groups: outGroups
};

writeFileSync(out, JSON.stringify(payload));
const bytes = Buffer.byteLength(JSON.stringify(payload));

const before = arcs.reduce((n, a) => n + a.length, 0);
console.log(`states kept      ${kept} (50 + DC, territories dropped)`);
console.log(`aleutians        ${dropped} island polygons west of ${AK_WEST_LIMIT} dropped`);
console.log(`points           ${before} -> ${totalPts} (${(100 - (totalPts / before) * 100).toFixed(1)}% dropped at ${TOLERANCE}deg)`);
for (const [k, g] of Object.entries(outGroups)) {
  console.log(`  ${k.padEnd(6)} ${String(g.arcs.length).padStart(4)} arcs  ${String(g.outer.length).padStart(4)} outer  ${String(g.inner.length).padStart(4)} inner`);
}
console.log(`wrote            ${out} (${(bytes / 1024).toFixed(0)} KB)`);
