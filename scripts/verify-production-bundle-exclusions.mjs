#!/usr/bin/env node
// Fails closed when a production build ships code from the debug-only galleries,
// dev login or the agentation annotation toolbar. Usage:
//   node scripts/verify-production-bundle-exclusions.mjs <dist-dir>
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * String literals that survive minification and are unique to one excluded module.
 * `source` is where the literal lives, so a test can keep each marker anchored.
 * Several gallery markers come from module-level data, which survives even when the
 * component body is eliminated as dead code.
 */
export const EXCLUDED_MODULE_MARKERS = Object.freeze([
  { module: "ConceptsGallery", marker: "UI Direction Explorations", source: "src/concepts/ConceptsGallery.tsx" },
  { module: "ConceptsGallery", marker: "Sensor Bracket Ring", source: "src/concepts/mock-data.ts" },
  { module: "StateGallery", marker: "Review OverDrafter states without hunting through flows", source: "src/pages/StateGallery.tsx" },
  { module: "StateGallery", marker: "Anonymous client landing state with intake CTA and auth entry points.", source: "src/pages/StateGallery.tsx" },
  { module: "DevLogin", marker: "\"dev-login\"", source: "src/pages/DevLogin.tsx" },
  { module: "agentation", marker: "overdrafter-annotation-toolbar", source: "src/components/debug/AnnotationToolbar.tsx" },
  { module: "agentation", marker: "--agentation-color-", source: "node_modules/agentation/dist/index.mjs" },
]);

const APP_CHUNK_PATTERN = /^App-[\w-]+\.js$/;

/** Scans every `<distDir>/assets/*.js` file. Missing input is a failure, never a pass. */
export function scanProductionBundle(distDir, markers = EXCLUDED_MODULE_MARKERS) {
  const assetsDir = path.join(distDir, "assets");
  let entries;
  try {
    if (!statSync(assetsDir).isDirectory()) {
      return { ok: false, error: `Not a directory: ${assetsDir}`, files: [], hits: [], appChunks: [] };
    }
    entries = readdirSync(assetsDir);
  } catch {
    return { ok: false, error: `Missing build assets directory: ${assetsDir}`, files: [], hits: [], appChunks: [] };
  }

  const files = entries.filter((name) => name.endsWith(".js")).sort();
  if (files.length === 0) {
    return { ok: false, error: `No JavaScript assets in ${assetsDir}`, files, hits: [], appChunks: [] };
  }

  const hits = [];
  const appChunks = [];
  for (const file of files) {
    const filePath = path.join(assetsDir, file);
    const source = readFileSync(filePath, "utf8");
    for (const { module, marker } of markers) {
      if (source.includes(marker)) hits.push({ module, marker, file });
    }
    if (APP_CHUNK_PATTERN.test(file)) appChunks.push({ file, bytes: statSync(filePath).size });
  }
  return { ok: hits.length === 0, error: null, files, hits, appChunks };
}

export function formatScanReport(distDir, result) {
  const lines = [`Production bundle exclusion scan: ${path.join(distDir, "assets")}`];
  if (result.error) {
    lines.push(`FAIL: ${result.error}`);
    return lines.join("\n");
  }
  lines.push(`Scanned ${result.files.length} JavaScript assets.`);
  for (const { file, bytes } of result.appChunks) {
    lines.push(`App chunk: ${file} ${bytes.toLocaleString("en-US")} bytes (${(bytes / 1000).toFixed(2)} kB)`);
  }
  if (result.appChunks.length === 0) lines.push("App chunk: no App-*.js asset found");
  for (const { module, marker, file } of result.hits) {
    lines.push(`FAIL: ${module} marker ${JSON.stringify(marker)} found in assets/${file}`);
  }
  if (result.ok) {
    const modules = [...new Set(EXCLUDED_MODULE_MARKERS.map(({ module }) => module))].join(", ");
    lines.push(`PASS: no markers for ${modules}.`);
  }
  return lines.join("\n");
}

function main(argv) {
  const distDir = argv[0] ?? "dist";
  const result = scanProductionBundle(distDir);
  const report = formatScanReport(distDir, result);
  if (result.ok) {
    console.log(report);
    return 0;
  }
  console.error(report);
  return result.error ? 2 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
