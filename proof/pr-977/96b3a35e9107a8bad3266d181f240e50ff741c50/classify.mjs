// Classify the touched paths with the repo matcher, at the base ref and at HEAD.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const root = process.argv[2];
const base = process.argv[3];
const lib = await import(pathToFileURL(`${root}/scripts/lib/sensitive-paths.mjs`).href);
const files = [
  "scripts/test-lane-contract.test.mjs",
  "scripts/test-lane-contract.mjs",
  "scripts/test-lane-notcontract.mjs",
];
for (const ref of [base, "HEAD"]) {
  const config = lib.loadSensitivePaths({ root, ref });
  console.log(`ref ${ref}:`, JSON.stringify(lib.classifyPaths(files, config)));
}
const headText = lib.readSensitivePathsText({ root, ref: "HEAD" });
const baseText = lib.readSensitivePathsText({ root, ref: base });
const head = lib.loadSensitivePaths({ root, ref: "HEAD" });
console.log("agents parity:", JSON.stringify(lib.checkAgentsParity(readFileSync(`${root}/AGENTS.md`, "utf8"), head)));
console.log("gate loosening:", JSON.stringify(lib.findGateLoosening({ baseText, headText, changedFiles: ["docs/sensitive-paths.json", "AGENTS.md", "scripts/fixtures/sensitive-paths/paths.json"] })));
