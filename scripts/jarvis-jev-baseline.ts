/** Reproduce the frozen synthetic routing baseline without any model call. */
import { readFileSync, writeFileSync } from "node:fs";
import { importContext } from "../src/features/engineering/prepared-workflow";
import { interpretPreparedMessage } from "../src/features/engineering/prepared-conversation";

const context = await importContext(readFileSync("e2e/fixtures/prepared-assembly-context.json", "utf8"));
const evidenceDir = "docs/release/jarvis-loop";
const records = readFileSync(`${evidenceDir}/jev-synthetic-cases.jsonl`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const results = records.map((item) => {
  const reply = interpretPreparedMessage(item.message, context);
  const baselineRoute = reply.kind === "proposal" ? "supported_depth_change" : reply.kind === "clarification" ? "clarification_needed" : "unsupported_request";
  return { id: item.id, expectedRoute: item.expectedRoute, baselineRoute, baselineDepthMm: reply.kind === "proposal" ? reply.proposal.depthMm : null, expectedDepthMm: item.expectedDepthMm,
    expectedAction: item.expectedAction, baselineMessage: reply.message, routeMatch: baselineRoute === item.expectedRoute,
    depthMatch: reply.kind !== "proposal" || reply.proposal.depthMm === item.expectedDepthMm };
});
writeFileSync(`${evidenceDir}/jev-existing-path-results.jsonl`, results.map((item) => JSON.stringify(item)).join("\n") + "\n");
const summary = { cases: results.length, routeMatches: results.filter((item) => item.routeMatch).length,
  falseSupports: results.filter((item) => item.baselineRoute === "supported_depth_change" && item.expectedRoute !== "supported_depth_change").length,
  falseRejections: results.filter((item) => item.baselineRoute !== "supported_depth_change" && item.expectedRoute === "supported_depth_change").length,
  depthMismatches: results.filter((item) => !item.depthMatch).length,
  mismatches: results.filter((item) => !item.routeMatch || !item.depthMatch).map((item) => item.id) };
writeFileSync(`${evidenceDir}/jev-existing-path-summary.json`, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary));
