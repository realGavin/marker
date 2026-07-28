import { extractAll } from "./extract.js";
import { transform } from "./transform.js";
import { report } from "./report.js";
import { load } from "./load.js";
import { pins } from "./pins.js";
import { seedLists } from "./seed-lists.js";

const cmd = process.argv[2];
switch (cmd) {
  case "extract":
    await extractAll(process.argv.includes("--force"));
    break;
  case "pins":
    await pins();
    break;
  case "seed-lists":
    await seedLists();
    break;
  case "embed":
    await (await import("./embed.js")).embed();
    break;
  case "describe":
    await (await import("./describe.js")).describe();
    break;
  case "icon":
    await (await import("./icon.js")).icon();
    break;
  case "scrub":
    await (await import("./scrub.js")).scrub();
    break;
  case "extract-holes":
    await (await import("./holes.js")).extractHoles(process.argv.includes("--force"));
    break;
  case "enrich-holes":
    await (await import("./holes.js")).enrichHoles();
    break;
  case "photos":
    await (await import("./photos.js")).photos();
    break;
  case "photos-report":
    await (await import("./photos.js")).photosReport();
    break;
  case "photos-upload":
    await (await import("./photos-upload.js")).photosUpload();
    break;
  case "transform":
    await transform();
    break;
  case "report":
    await report();
    break;
  case "load":
    await load();
    break;
  case "all":
    await extractAll();
    await transform();
    await report();
    break;
  default:
    console.log("usage: pnpm etl <extract|transform|report|load|all> [--force]");
    process.exit(1);
}
