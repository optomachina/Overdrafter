import { comparisonCases, runComparisonCase, simulatedRecoveryDecision } from "../recovery/comparison.js";
import { createJevRecoveryDecider } from "../recovery/jevDecision.js";

const live = process.argv.includes("--live");
const key = process.env.TYPESAFE_API_KEY;
if (live && !key) {
  console.error("Live comparison blocked: TYPESAFE_API_KEY unavailable. No inference calls made.");
  process.exitCode = 1;
} else {
  const decide = live ? createJevRecoveryDecider(key!) : simulatedRecoveryDecision;
  const rows = [];
  for (const testCase of comparisonCases) {
    rows.push({ mode: "scripted", ...await runComparisonCase(testCase) });
    rows.push({ mode: live ? "live_jev" : "simulated_decisions", ...await runComparisonCase(testCase, decide) });
  }
  console.log(JSON.stringify({
    schemaVersion: "browser-recovery-comparison.v1", measuredAt: new Date().toISOString(),
    inference: live ? "actual API inference" : "NO MODEL INFERENCE: scripted responses exercise recovery plumbing only",
    costUsd: live ? null : 0,
    costNote: live ? "Unknown billing cost; actual token usage is in receipts. No pricing assumptions." : "No paid API calls; token zeros are simulated, not measured inference.",
    timingScope: "Per case: synthetic file setup, fresh Chromium launch, real portal kernel, observation, decision and action. Excludes dependency installation.",
    rows,
  }, null, 2));
}
