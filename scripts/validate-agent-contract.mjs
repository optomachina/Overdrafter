import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function validateAgentContract(repoRoot = root) {
  const read = (name) => fs.readFileSync(path.join(repoRoot, name), "utf8");
  const agents = read("AGENTS.md");
  const claude = read("CLAUDE.md");
  const workflow = read("WORKFLOW.md");
  const errors = [];

  if (Buffer.byteLength(agents) > 24 * 1024) {
    errors.push("AGENTS.md exceeds the 24 KiB repository budget");
  }
  if (Buffer.byteLength(claude) > 2 * 1024) {
    errors.push("CLAUDE.md is no longer a thin adapter");
  }
  for (const required of [
    "Synthetic-fixture lane",
    "Complexity alone never requires human approval",
    "durable run store are authoritative",
    "governor observes liveness",
  ]) {
    if (!agents.includes(required)) errors.push(`AGENTS.md missing: ${required}`);
  }
  for (const prohibited of [
    "High-complexity override",
    "one attempt, zero retries",
    "internal plan state is the execution source of truth",
  ]) {
    if (agents.toLowerCase().includes(prohibited.toLowerCase())) {
      errors.push(`AGENTS.md retains obsolete gate: ${prohibited}`);
    }
  }
  if (/gpt-5\.3|shell_environment_policy\.inherit=all/.test(workflow)) {
    errors.push("WORKFLOW.md retains an obsolete model or inherited-all environment setting");
  }
  const turns = Number(workflow.match(/max_turns:\s*(\d+)/)?.[1] ?? 0);
  if (turns < 10) errors.push("WORKFLOW.md does not allow sustained continuation");
  if (!workflow.includes("codex app-server")) {
    errors.push("WORKFLOW.md must use the configured Codex model via codex app-server");
  }
  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = validateAgentContract(process.argv[2] ? path.resolve(process.argv[2]) : root);
  if (errors.length) {
    for (const error of errors) console.error(`agent-contract: ${error}`);
    process.exitCode = 1;
  } else {
    console.log("agent-contract: valid");
  }
}
