// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

export function findModelRoutingDrift(agentsText, routingYamlText) {
  const errors = [];
  let entries;
  try {
    entries = parse(routingYamlText);
  } catch {
    errors.push("Routing YAML must parse successfully.");
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    errors.push("Routing YAML must be a non-empty array.");
    entries = [];
  }
  const labels = new Set();
  for (const [index, entry] of entries.entries()) {
    for (const field of ["label", "provider", "model", "use_for", "notes"]) {
      if (typeof entry?.[field] !== "string" || !entry[field].trim()) {
        errors.push(`Routing entry ${index + 1} must have a non-empty string ${field}.`);
      }
    }
    if (typeof entry?.label !== "string") continue;
    if (!/^model:[a-z0-9-]+$/.test(entry.label)) {
      errors.push(`Invalid routing label: ${entry.label}.`);
    }
    if (labels.has(entry.label)) errors.push(`Duplicate routing label: ${entry.label}.`);
    labels.add(entry.label);
  }
  // Ignore periods inside the backticked path when splitting sentences.
  const sentences = agentsText.match(/(?:`[^`]*`|[^.!?`])+[.!?]?/g) ?? [];
  if (!sentences.some((sentence) => sentence.includes("docs/agent-graph/model-routing.yaml")
    && sentence.includes("source of truth"))) {
    errors.push("AGENTS.md must name docs/agent-graph/model-routing.yaml as the source of truth.");
  }
  const mentioned = new Set(agentsText.match(/\bmodel:[a-z0-9-]+\b/g) ?? []);
  for (const label of mentioned) {
    if (!labels.has(label)) errors.push(`AGENTS.md label missing from YAML: ${label}.`);
  }
  for (const label of labels) {
    if (!mentioned.has(label)) errors.push(`YAML label not mentioned in AGENTS.md: ${label}.`);
  }
  for (const family of ["Sonnet", "Opus"]) {
    if (new RegExp(`\\b${family}\\b`).test(agentsText)
      && !entries.some((entry) => typeof entry?.model === "string" && entry.model.includes(family))) {
      errors.push(`Review model family missing from YAML: ${family}.`);
    }
  }
  const header = routingYamlText.match(/^(?:#[^\n]*(?:\n|$))+/)?.[0] ?? "";
  if (!/source of truth for (?:the )?model labels\b/i.test(header)) {
    errors.push("Routing YAML header must say it is the source of truth for model labels.");
  }
  return errors;
}

const repoRoot = resolve(import.meta.dirname, "..");
const agentsText = readFileSync(resolve(repoRoot, "AGENTS.md"), "utf8");
const routingText = readFileSync(resolve(repoRoot, "docs/agent-graph/model-routing.yaml"), "utf8");
const opusBlock = routingText.match(/- label: "model:opus"[\s\S]*?(?=\n- label:|$)/)[0];

describe("model routing drift", () => {
  it("keeps the real AGENTS.md and routing YAML consistent", () => {
    expect(findModelRoutingDrift(agentsText, routingText)).toEqual([]);
  });

  it("detects a label removed from YAML", () => {
    expect(findModelRoutingDrift(agentsText, routingText.replace(opusBlock, "")))
      .toContain("AGENTS.md label missing from YAML: model:opus.");
  });

  it("detects an extra YAML label", () => {
    const extra = opusBlock.replace('"model:opus"', '"model:extra"');
    expect(findModelRoutingDrift(agentsText, `${routingText}\n${extra}`))
      .toContain("YAML label not mentioned in AGENTS.md: model:extra.");
  });

  it("detects an unknown label in AGENTS.md", () => {
    expect(findModelRoutingDrift(`${agentsText}\nmodel:unknown`, routingText))
      .toContain("AGENTS.md label missing from YAML: model:unknown.");
  });

  it("detects a removed source-of-truth pointer sentence", () => {
    const withoutPointer = agentsText.replace(/`docs\/agent-graph\/model-routing\.yaml`[^.]*\./, "");
    expect(findModelRoutingDrift(withoutPointer, routingText))
      .toContain("AGENTS.md must name docs/agent-graph/model-routing.yaml as the source of truth.");
  });

  it("detects a missing provider", () => {
    expect(findModelRoutingDrift(agentsText, routingText.replace(/  provider: [^\n]+\n/, "")))
      .toContain("Routing entry 1 must have a non-empty string provider.");
  });

  it("detects a duplicate label", () => {
    expect(findModelRoutingDrift(agentsText, `${routingText}\n${opusBlock}`))
      .toContain("Duplicate routing label: model:opus.");
  });

  it("detects a renamed Opus model", () => {
    expect(findModelRoutingDrift(agentsText, routingText.replace("model: Claude Opus", "model: Claude Other")))
      .toContain("Review model family missing from YAML: Opus.");
  });
});
