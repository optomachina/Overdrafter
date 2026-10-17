// @vitest-environment node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { classifyPath, loadConfig } from "./sensitive-class-detect.mjs";
import {
  CHARACTERS,
  FIXTURE_PATH,
  V1_CLASSES,
  V1_COMMIT,
  V1_SAFE_CATEGORIES,
  describeCharacter,
  formatSweep,
  nonAsciiCaseFolds,
  residualClass,
  runSweep,
  sweepNames,
  v1ClassifyPath,
  witnessProblems,
} from "./sensitive-class-sweep.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const { config } = loadConfig();
const fixture = JSON.parse(readFileSync(path.join(repoRoot, FIXTURE_PATH), "utf8"));

// Every character a glob cannot spell, except "\\" (the matcher also reads it
// as a separator), leaves rls uncovered; so does a camelCase boundary.
const EXPECTED_RESIDUAL = [
  ...CHARACTERS.filter((char) => !/^[A-Za-z0-9._\-/,\\]$/.test(char)).map((char) => `rls after ${describeCharacter(char)}`),
  "rls at a camelCase boundary",
].sort();

describe("v1 rules (frozen copy of 0163daf7)", () => {
  const v1 = spawnSync("git", ["show", `${V1_COMMIT}:scripts/sensitive-classes.json`], { cwd: repoRoot, encoding: "utf8" });
  // CI checks out one commit; the comparison runs where the history is present.
  it.skipIf(v1.status !== 0)("equal the path rules of scripts/sensitive-classes.json at 0163daf7", () => {
    const raw = JSON.parse(v1.stdout);
    const rules = (entries) =>
      Object.fromEntries(Object.entries(entries).map(([name, entry]) => [name, Object.fromEntries(Object.entries(entry).filter(([key]) => ["paths", "path_keywords", "exclude", "exclude_keywords"].includes(key) && entry[key].length))]));
    expect(Object.keys(V1_CLASSES)).toEqual(Object.keys(raw.classes));
    expect(rules(V1_CLASSES)).toEqual(rules(raw.classes));
    expect(rules(V1_SAFE_CATEGORIES)).toEqual(rules(raw.safe_categories));
  });

  it.each([
    ["src/features/q/x~rls.ts", ["rls"]],
    ["src/features/quotes/quoteRls.ts", ["rls"]],
    ["src/features/provider/_upload/Form.tsx", ["provider"]],
    ["src/features/providerUpload.tsx", ["provider"]],
    ["src/features/checKout.tsx", ["billing"]],
    ["scripts/native/x.mjs", ["ci"]],
    ["src/lib/urls.ts", []],
    ["src/features/provideradmission.tsx", []],
  ])("classify %j as 0163daf7 did: %j", (file, classes) => {
    expect(v1ClassifyPath(file).classes).toEqual(classes);
  });

  it("finds the non-ASCII characters whose lower case is an ASCII letter", () => {
    expect(Object.fromEntries(nonAsciiCaseFolds())).toEqual({ k: ["K"] });
  });
});

describe("residual classes", () => {
  it.each([
    ["src/features/q/x~rls.ts", "rls after ~"],
    ["src/features/q/x rls.ts", "rls after U+0020"],
    ["src/features/quotes/quoteRls.ts", "rls at a camelCase boundary"],
    ["src/features/q/xİrls.ts", "rls after U+0130"],
    ["src/features/q/x,rls.ts", null], // a glob can spell ","
    ["src/features/q/rls.ts", null], // a segment start
    ["src/features/auth~x.ts", null], // not rls
  ])("%j -> %j", (file, key) => {
    expect(residualClass(file, v1ClassifyPath(file))).toBe(key);
  });

  it.each(EXPECTED_RESIDUAL)("%s has a witness whose covering globs also match src/lib/urls.ts", (key) => {
    expect(witnessProblems(key, config, fixture)).toEqual([]);
  });

  it("rejects a witness that a glob could cover", () => {
    expect(witnessProblems("rls after ,", config, fixture)).toEqual([
      'rls after ,: witness "src/lib/,rls.ts" is sensitive here, so the class is not residual',
      'rls after ,: witness "src/lib/,rls.ts" differs from src/lib/urls.ts in more than the unspellable character or case',
    ]);
  });
});

// The full sweep (every directory and tail) runs as `node scripts/sensitive-class-sweep.mjs`
// and gives the PR body's numbers; this runs every character and position in two directories.
describe("sweep against 0163daf7", () => {
  it("loses no sensitive name outside the residual classes, and makes no name newly safe", () => {
    const stats = runSweep({ config, names: sweepNames({ directories: ["src/features", "scripts"], tails: [".tsx"] }) });
    expect(stats.total).toBeGreaterThan(100_000);
    expect(stats.unexplained.slice(0, 20)).toEqual([]);
    expect(stats.newlySafeNames).toEqual([]);
    expect([...stats.residual.keys()].sort()).toEqual(EXPECTED_RESIDUAL);
    expect(formatSweep(stats)).toContain("Unexplained: 0.");
  }, 180_000);

  it("generates the names the reviews found, and classifies them as sensitive", () => {
    const wanted = [
      "src/features/provider/_upload.tsx",
      "src/pages/provider/(admission)/index.ts",
      "src/features/provider/[upload]/index.ts",
      "src/features/x-provider_/upload.tsx",
      "worker/src/provider/_admission.tsx",
      "src/features/provider/_/upload.tsx",
      "src/features/quote~rls.tsx",
      "src/features/a=rls.tsx",
      "scripts/x,rls.tsx",
    ];
    const missing = new Set(wanted);
    for (const name of sweepNames({ directories: ["src/features", "src/pages", "worker/src", "scripts"], tails: [".tsx", "/index.ts"] })) missing.delete(name);
    expect([...missing]).toEqual([]);
    for (const file of wanted) expect(v1ClassifyPath(file).classes.length, file).toBeGreaterThan(0);
    for (const file of ["src/features/provider/_upload.tsx", "src/pages/provider/(admission)/index.ts", "worker/src/provider/_admission.tsx", "scripts/x,rls.tsx"]) {
      expect(classifyPath(file, config).classes.length, file).toBeGreaterThan(0);
    }
  }, 60_000);
});
