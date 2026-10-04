// @vitest-environment node

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { EXCLUDED_MODULE_MARKERS, scanProductionBundle } from "./verify-production-bundle-exclusions.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptPath = fileURLToPath(new URL("./verify-production-bundle-exclusions.mjs", import.meta.url));
const tempDirs = [];

function makeDist(files) {
  const dist = mkdtempSync(path.join(tmpdir(), "ovd-bundle-scan-"));
  tempDirs.push(dist);
  if (files) {
    mkdirSync(path.join(dist, "assets"));
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dist, "assets", name), content);
  }
  return dist;
}

function runCli(dist) {
  return spawnSync(process.execPath, [scriptPath, dist], { encoding: "utf8" });
}

function sourceFilesUnder(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(fullPath);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [fullPath] : [];
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("production bundle exclusion scan", () => {
  it("fails closed when the build directory is missing", () => {
    const missing = path.join(makeDist(), "does-not-exist");
    expect(scanProductionBundle(missing)).toMatchObject({ ok: false, error: expect.stringContaining("Missing build assets directory") });
    const result = runCli(missing);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("FAIL: Missing build assets directory");
  });

  it("fails closed when the build has no JavaScript assets", () => {
    const dist = makeDist({ "main-abc.css": "body{}" });
    expect(scanProductionBundle(dist)).toMatchObject({ ok: false, error: expect.stringContaining("No JavaScript assets") });
    expect(runCli(dist).status).toBe(2);
  });

  it("passes a clean build and reports the App chunk size", () => {
    const dist = makeDist({ "App-Ab1_c.js": "console.log('production');", "index-x.js": "export{}" });
    const result = scanProductionBundle(dist);
    expect(result).toMatchObject({ ok: true, hits: [], appChunks: [{ file: "App-Ab1_c.js", bytes: 26 }] });
    const cli = runCli(dist);
    expect(cli.status).toBe(0);
    expect(cli.stdout).toContain("Scanned 2 JavaScript assets.");
    expect(cli.stdout).toContain("App chunk: App-Ab1_c.js 26 bytes");
    expect(cli.stdout).toContain("PASS: no markers for ConceptsGallery, StateGallery, DevLogin, agentation.");
  });

  it.each(EXCLUDED_MODULE_MARKERS)("fails when a $module marker ships: $marker", ({ module, marker }) => {
    // The scan is textual, so the fixture chunk embeds the marker verbatim between minified-looking code.
    const dist = makeDist({ "App-a.js": "export{}", "Lazy-b.js": `var a=1;${marker};var b=2;` });
    const result = scanProductionBundle(dist);
    expect(result.ok).toBe(false);
    expect(result.hits).toEqual([{ module, marker, file: "Lazy-b.js" }]);
    const cli = runCli(dist);
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain(`FAIL: ${module} marker ${JSON.stringify(marker)} found in assets/Lazy-b.js`);
  });

  it("covers every excluded module with at least one marker", () => {
    expect([...new Set(EXCLUDED_MODULE_MARKERS.map(({ module }) => module))].sort())
      .toEqual(["ConceptsGallery", "DevLogin", "StateGallery", "agentation"]);
  });

  it("keeps each marker anchored in its source and unique to it within src", () => {
    const srcFiles = sourceFilesUnder(path.join(repoRoot, "src")).map((file) => [file, readFileSync(file, "utf8")]);
    for (const { marker, source } of EXCLUDED_MODULE_MARKERS) {
      const sourcePath = path.join(repoRoot, source);
      expect(readFileSync(sourcePath, "utf8"), `${source} must still contain ${marker}`).toContain(marker);
      const elsewhere = srcFiles.filter(([file, text]) => file !== sourcePath && text.includes(marker)).map(([file]) => file);
      expect(elsewhere, `${marker} must not appear elsewhere in src`).toEqual([]);
    }
  });
});
