#!/usr/bin/env node
// Single source of truth for which Playwright specs prove which feature, and
// under which Playwright config each spec actually runs (a spec that skips
// under the default config must name its own config here). Specs that cannot
// prove their feature yet are listed in PENDING_SPECS with the issue that
// unblocks them, never in FEATURE_SPECS.
import { fileURLToPath } from "node:url";

export const DEFAULT_CONFIG = "playwright.config.ts";

// Ports each config's webServer binds; doctor refuses to start if one is taken.
export const CONFIG_PORTS = {
  [DEFAULT_CONFIG]: 4173,
  "e2e/admin-operations.config.ts": 4174,
};

// Each config's testDir, relative to the app root. Playwright reports a test's
// file relative to it, so the judge resolves report files against this.
export const CONFIG_TEST_DIRS = {
  [DEFAULT_CONFIG]: "e2e",
  "e2e/admin-operations.config.ts": "e2e",
};

const spec = (path, config = DEFAULT_CONFIG) => ({ spec: path, config });

export const FEATURE_SPECS = {
  auth: {
    fixture: [spec("e2e/client-shell.spec.ts"), spec("e2e/part-reload.spec.ts")],
    local: [spec("e2e/smoke.spec.ts"), spec("e2e/access-scope.spec.ts")],
  },
  quote: {
    fixture: [spec("e2e/quote-comparison.spec.ts")],
    local: [spec("e2e/intake.spec.ts"), spec("e2e/sourcing-destination.spec.ts")],
  },
  provider: {
    fixture: [
      // Skips unless served on 4174 by its synthetic admin server, so it runs
      // under its own config (never the default one).
      spec("e2e/admin-operations.spec.ts", "e2e/admin-operations.config.ts"),
      spec("e2e/engineering-admin-route.spec.ts"),
      spec("e2e/journeys/jarvis-front-door.spec.ts"),
    ],
    local: [],
  },
};

// Specs that belong to a feature but cannot prove it yet. They are not run,
// never count as a pass, and the judge lists them as pending. Each entry names
// the Linear issue that unblocks it, and the spec must still mark its journey
// test.fail() with that issue (scripts/verify-overdrafter-skill.test.mjs checks
// this), so an entry cannot outlive its reason. When the issue lands, move the
// spec back into FEATURE_SPECS; a test.fail() journey there is a FAIL.
export const PENDING_SPECS = {};

// The pending entries for the requested features in a mode, in feature order.
export function pendingFor(features, mode) {
  return features.flatMap((name) => (PENDING_SPECS[name]?.[mode] ?? []).map((p) => ({ feature: name, ...p })));
}

export const pendingNote = (p) => `PENDING: ${p.feature} ${p.spec} (${p.reason}; not run, not counted as a pass)`;

export function parseFeatures(list) {
  if (typeof list !== "string" || list.trim() === "") throw new Error("no features requested");
  const names = list.split(",").map((s) => s.trim());
  if (names.some((n) => n === "")) throw new Error(`empty feature name in list: "${list}"`);
  return names;
}

export const skipNote = (mode) => `SKIPPED: no ${mode} specs`;

// Splits the requested features into those with specs in the mode and those
// without. A feature with no specs in the mode is dropped from a multi-feature
// request and reported as skipped (never as passing). Fails closed when a
// single requested feature has no specs in the mode or nothing is left.
export function selectFeatures(features, mode) {
  if (!["fixture", "local"].includes(mode)) throw new Error(`unknown mode: ${mode}`);
  for (const name of features) {
    if (!FEATURE_SPECS[name]) throw new Error(`unknown feature: ${name}`);
  }
  const included = features.filter((name) => FEATURE_SPECS[name][mode].length > 0);
  const skipped = features.filter((name) => FEATURE_SPECS[name][mode].length === 0);
  if (features.length === 1 && skipped.length) throw new Error(`feature ${skipped[0]} has no ${mode} specs`);
  if (included.length === 0) throw new Error(`no ${mode} specs for features ${features.join(",") || "(none)"}`);
  return { included, skipped };
}

// Returns [{ spec, config }], deduplicated, for the features selectFeatures keeps.
export function specsFor(features, mode) {
  const out = new Map();
  for (const name of selectFeatures(features, mode).included) {
    for (const s of FEATURE_SPECS[name][mode]) out.set(`${s.config}\t${s.spec}`, s);
  }
  return [...out.values()];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [features = "auth,quote,provider", mode = "fixture"] = process.argv.slice(2);
    const names = parseFeatures(features);
    // One "SKIPPED\t<feature>" line per dropped feature, then one "<config>\t<spec>" line per spec.
    for (const name of selectFeatures(names, mode).skipped) console.log(`SKIPPED\t${name}`);
    // Pending specs go to stderr: verify.sh logs them without parsing them as specs.
    for (const p of pendingFor(names, mode)) console.error(pendingNote(p));
    for (const s of specsFor(names, mode)) console.log(`${s.config}\t${s.spec}`);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}
