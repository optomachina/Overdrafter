#!/usr/bin/env node
// Single source of truth for which Playwright specs prove which feature, and
// under which Playwright config each spec actually runs (a spec that skips
// under the default config must name its own config here).
import { fileURLToPath } from "node:url";

export const DEFAULT_CONFIG = "playwright.config.ts";

// Ports each config's webServer binds; doctor refuses to start if one is taken.
export const CONFIG_PORTS = {
  [DEFAULT_CONFIG]: 4173,
  "e2e/admin-operations.config.ts": 4174,
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
      // Skips unless served on 4174 by its synthetic admin server.
      spec("e2e/admin-operations.spec.ts", "e2e/admin-operations.config.ts"),
      spec("e2e/journeys/jarvis-front-door.spec.ts"),
      spec("e2e/engineering-admin-route.spec.ts"),
    ],
    local: [],
  },
};

export function parseFeatures(list) {
  if (typeof list !== "string" || list.trim() === "") throw new Error("no features requested");
  const names = list.split(",").map((s) => s.trim());
  if (names.some((n) => n === "")) throw new Error(`empty feature name in list: "${list}"`);
  return names;
}

// Returns [{ spec, config }], deduplicated. Fails closed: every requested
// feature must have at least one spec in the chosen mode.
export function specsFor(features, mode) {
  if (!["fixture", "local"].includes(mode)) throw new Error(`unknown mode: ${mode}`);
  const out = new Map();
  for (const name of features) {
    const entry = FEATURE_SPECS[name];
    if (!entry) throw new Error(`unknown feature: ${name}`);
    if (entry[mode].length === 0) throw new Error(`feature ${name} has no ${mode} specs`);
    for (const s of entry[mode]) out.set(`${s.config}\t${s.spec}`, s);
  }
  return [...out.values()];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [features = "auth,quote,provider", mode = "fixture"] = process.argv.slice(2);
    // One "<config>\t<spec>" line per spec.
    for (const s of specsFor(parseFeatures(features), mode)) console.log(`${s.config}\t${s.spec}`);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}
