#!/usr/bin/env node
// Single source of truth for which Playwright specs prove which feature.
import { fileURLToPath } from "node:url";

export const FEATURE_SPECS = {
  auth: {
    fixture: ["e2e/client-shell.spec.ts", "e2e/part-reload.spec.ts"],
    local: ["e2e/smoke.spec.ts", "e2e/access-scope.spec.ts"],
  },
  quote: {
    fixture: ["e2e/quote-comparison.spec.ts"],
    local: ["e2e/intake.spec.ts", "e2e/sourcing-destination.spec.ts"],
  },
  provider: {
    fixture: ["e2e/admin-operations.spec.ts", "e2e/journeys/jarvis-front-door.spec.ts"],
    local: ["e2e/engineering-admin-route.spec.ts"],
  },
};

export function specsFor(features, mode) {
  const out = [];
  for (const name of features) {
    const entry = FEATURE_SPECS[name];
    if (!entry) throw new Error(`unknown feature: ${name}`);
    out.push(...entry[mode]);
  }
  return [...new Set(out)];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [features = "auth,quote,provider", mode = "fixture"] = process.argv.slice(2);
  if (!["fixture", "local"].includes(mode)) throw new Error(`unknown mode: ${mode}`);
  console.log(specsFor(features.split(","), mode).join("\n"));
}
