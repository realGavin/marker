#!/usr/bin/env node
/**
 * Engine-purity lint: the engine (apps/mobile, packages/core) must contain no
 * niche-specific vocabulary. Niche words live only in skin packages and data.
 * Exit 1 with file:line report on any violation.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const ENGINE_DIRS = ["apps/mobile/src", "packages/core/src"];
const BANNED = [
  /\bgolf\b/i,
  /\bgolfer/i,
  /\bcourses?\b/i,
  /\bfairway/i,
  /\btee\b/i,
  /\bcaddie/i,
  /\bplayed\b/i, // engine says "visited"; skins map vocabulary
  /\brounds\b/i, // plural only; "Math.round" stays legal
];
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".json"]);
// The skin import path is allowed; so is an explicit escape hatch for
// unavoidable references (e.g. a legacy DB field name we don't control).
const ALLOWED_LINE = /@marker\/skin-|SKIN_PACKAGE|skin-golf|engine-purity-ignore/;

let violations = 0;
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (EXTENSIONS.has(p.slice(p.lastIndexOf(".")))) check(p);
  }
}
function check(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (ALLOWED_LINE.test(line)) return;
    for (const re of BANNED) {
      if (re.test(line)) {
        console.error(`${relative(ROOT, file)}:${i + 1}  banned niche word ${re}  ->  ${line.trim().slice(0, 100)}`);
        violations++;
      }
    }
  });
}

for (const d of ENGINE_DIRS) {
  try {
    walk(join(ROOT, d));
  } catch {
    /* dir may not exist yet */
  }
}
if (violations > 0) {
  console.error(`\nEngine purity FAILED: ${violations} violation(s). Niche words belong in packages/skins/*.`);
  process.exit(1);
}
console.log("Engine purity OK: no niche vocabulary in engine code.");
