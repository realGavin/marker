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
  case "enrich-par":
    await (await import("./enrich-par.js")).enrichPar();
    break;
  case "extract-holes-geom":
    await (await import("./holes-geom.js")).extractHolesGeom(
      process.argv.includes("--force"),
      process.argv.find((a) => a.startsWith("--state="))?.split("=")[1],
    );
    break;
  case "enrich-length":
    await (await import("./enrich-length.js")).enrichLength();
    break;
  case "enrich-elevation": {
    const limitArg = process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1];
    await (await import("./enrich-elevation.js")).enrichElevation(limitArg ? Number(limitArg) : undefined);
    break;
  }
  case "enrich-setting": {
    const limitArg = process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1];
    await (await import("./enrich-setting.js")).enrichSetting(limitArg ? Number(limitArg) : undefined);
    break;
  }
  case "enrich-wind": {
    const limitArg = process.argv.find((a) => a.startsWith("--limit="))?.split("=")[1];
    await (await import("./enrich-wind.js")).enrichWind(limitArg ? Number(limitArg) : undefined);
    break;
  }
  case "enrich-season":
    await (await import("./enrich-season.js")).enrichSeason();
    break;
  case "enrich-wikidata":
    await (await import("./enrich-wikidata.js")).enrichWikidata();
    break;
  case "report-intel":
    await (await import("./report-intel.js")).reportIntel();
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
    console.log(
      "usage: pnpm etl <extract|transform|report|load|all|" +
        "extract-holes|enrich-holes|enrich-par|extract-holes-geom|enrich-length|" +
        "enrich-elevation|enrich-setting|enrich-wind|enrich-season|enrich-wikidata|" +
        "report-intel|pins|seed-lists|embed|describe|icon|scrub|photos|photos-report|photos-upload> [--force] [--state=XX]",
    );
    process.exit(1);
}
