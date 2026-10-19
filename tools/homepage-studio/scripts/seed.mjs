#!/usr/bin/env node
// (Re)create data/project.json from data/seed.json without destroying versions.
//   node tools/homepage-studio/scripts/seed.mjs [--with-baselines] [--dir <dataDir>]
// --with-baselines copies public/v6..v9/index.html (read-only on public/) into
// <dataDir>/baselines/ so a hosted studio can show them. Nothing is written to public/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFsStorage } from "../lib/storage/fs.mjs";
import { seedProject } from "../lib/seed.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function runSeed({ dataDir = path.join(root, "data"), seedFile = path.join(dataDir, "seed.json"), withBaselines = false, publicDir = path.resolve(root, "../../public") } = {}) {
  const seed = JSON.parse(fs.readFileSync(seedFile, "utf8"));
  const storage = createFsStorage({ dataDir });
  const existing = await storage.readProject();
  const project = seedProject(seed, existing);
  await storage.replaceProject(project);
  if (withBaselines) {
    for (const b of project.baselines) {
      const src = path.join(publicDir, b.id, "index.html");
      const dst = path.join(dataDir, "baselines", b.id, "index.html");
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    }
  }
  return { created: !existing, fields: Object.keys(project.fields).length, sections: project.sections.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const di = args.indexOf("--dir");
  const dataDir = di >= 0 ? path.resolve(args[di + 1]) : undefined;
  const out = await runSeed({ ...(dataDir ? { dataDir, seedFile: path.join(root, "data", "seed.json") } : {}), withBaselines: args.includes("--with-baselines") });
  console.log(`${out.created ? "Created" : "Updated"} project.json: ${out.sections} sections, ${out.fields} fields. Existing versions were kept.`);
}
