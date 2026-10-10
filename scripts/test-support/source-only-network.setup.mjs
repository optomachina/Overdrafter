import { createRequire } from "node:module";
import { afterAll, expect } from "vitest";

const require = createRequire(import.meta.url);
const guard = process[Symbol.for("overdrafter.source-only-network")];
if (!guard) {
  throw new Error("Source-only verification requires the source-only-network.cjs NODE_OPTIONS preload in every Node process.");
}
// jsdom creates another global realm after Node preloads have run.
require("./source-only-network.cjs").installBrowserGuards(globalThis);
afterAll(() => guard.assertNoUnexpectedNetwork());

// These lanes have transports outside this Node/jsdom guard. Fail before the
// test module (including its top-level imports/hooks) can start a browser/vendor.
const testPath = (expect.getState().testPath ?? "").replaceAll("\\", "/");
if (!testPath) throw new Error("Source-only verification cannot classify a test without its exact path.");
const unsupportedLanes = [
  "/worker/src/recovery/browserRecovery.test.ts",
  "/worker/src/adapters/fictiv.live.test.ts",
  "/scripts/api-request-quote.test.mjs",
];
if (unsupportedLanes.some((suffix) => testPath.endsWith(suffix)) ||
    (testPath.endsWith("/scripts/run-ovd419-live-release.test.mjs") && process.env.OVD419_VALIDATE_GCLOUD_HELP === "1")) {
  throw new Error("Source-only verification blocked this browser/native/integration lane before test-module execution; its transports need separate reviewed isolation. This is not a passing or skipped test.");
}
