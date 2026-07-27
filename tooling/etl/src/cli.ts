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
