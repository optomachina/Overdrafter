// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";

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
  // Split on sentence-ending punctuation followed by whitespace so the periods inside the
  // path never end a sentence, whether or not the path is backticked.
  const sentences = agentsText.split(/(?<=[.!?])\s+/);
  if (!sentences.some((sentence) => sentence.includes("docs/agent-graph/model-routing.yaml")
    && /\bis the source of truth\b/.test(sentence))) {
    errors.push("AGENTS.md must name docs/agent-graph/model-routing.yaml as the source of truth.");
  }
  const mentioned = new Set(agentsText.match(/\bmodel:[a-z0-9-]+\b/g) ?? []);
  for (const label of mentioned) {
    if (!labels.has(label)) errors.push(`AGENTS.md label missing from YAML: ${label}.`);
  }
  for (const label of labels) {
    if (!mentioned.has(label)) errors.push(`YAML label not mentioned in AGENTS.md: ${label}.`);
  }
  // Each review family must sit on its own label, so swapping the two models is drift too.
  const familyByLabel = [["model:opus", "Opus"], ["model:sonnet", "Sonnet"]];
  for (const [label, family] of familyByLabel) {
    const entry = entries.find((candidate) => candidate?.label === label);
    if (new RegExp(`\\b${family}\\b`).test(agentsText)
      && !(typeof entry?.model === "string" && entry.model.includes(family))) {
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
const routingHeader = routingText.match(/^(?:#[^\n]*(?:\n|$))+/)[0];
const routingEntries = parse(routingText);
const entryFor = (label) => routingEntries.find((entry) => entry.label === label);

// Build drift fixtures from the parsed entries instead of slicing the YAML text, so the cases
// do not depend on how the labels happen to be quoted in the file.
const renderRouting = (entries) => `${routingHeader}\n${stringify(entries)}`;

describe("model routing drift", () => {
  it("keeps the real AGENTS.md and routing YAML consistent", () => {
    expect(findModelRoutingDrift(agentsText, routingText)).toEqual([]);
  });

  it("accepts the same entries whatever the YAML quoting style", () => {
    expect(findModelRoutingDrift(agentsText, renderRouting(routingEntries))).toEqual([]);
    const singleQuoted = routingText.replace(/label: "(model:[a-z0-9-]+)"/g, "label: '$1'");
    expect(singleQuoted).not.toBe(routingText);
    expect(findModelRoutingDrift(agentsText, singleQuoted)).toEqual([]);
  });

  it("detects a label removed from YAML", () => {
    const withoutOpus = routingEntries.filter((entry) => entry.label !== "model:opus");
    expect(findModelRoutingDrift(agentsText, renderRouting(withoutOpus)))
      .toContain("AGENTS.md label missing from YAML: model:opus.");
  });

  it("detects an extra YAML label", () => {
    const withExtra = [...routingEntries, { ...entryFor("model:opus"), label: "model:extra" }];
    expect(findModelRoutingDrift(agentsText, renderRouting(withExtra)))
      .toContain("YAML label not mentioned in AGENTS.md: model:extra.");
  });

  it("detects an unknown label in AGENTS.md", () => {
    expect(findModelRoutingDrift(`${agentsText}\nmodel:unknown`, routingText))
      .toContain("AGENTS.md label missing from YAML: model:unknown.");
  });

  it("detects a removed source-of-truth pointer sentence", () => {
    // Target the pointer sentence itself: the path also appears in the infra_ci glob list.
    const withoutPointer = agentsText.replace(/`docs\/agent-graph\/model-routing\.yaml` is the source of truth[^.]*\./, "");
    expect(withoutPointer).not.toBe(agentsText);
    expect(findModelRoutingDrift(withoutPointer, routingText))
      .toContain("AGENTS.md must name docs/agent-graph/model-routing.yaml as the source of truth.");
  });

  it("accepts the pointer sentence with or without backticks around the path", () => {
    // Unbacktick the pointer sentence itself, not the first mention (the infra_ci glob list also names the path).
    const unbackticked = agentsText.replace(
      "`docs/agent-graph/model-routing.yaml` is the source of truth",
      "docs/agent-graph/model-routing.yaml is the source of truth",
    );
    expect(unbackticked).not.toBe(agentsText);
    expect(unbackticked).toContain("docs/agent-graph/model-routing.yaml is the source of truth");
    expect(findModelRoutingDrift(unbackticked, routingText)).toEqual([]);
  });

  it("detects a pointer sentence that denies the source of truth", () => {
    const negated = agentsText.replace(
      "model-routing.yaml` is the source of truth",
      "model-routing.yaml` is not the source of truth",
    );
    expect(negated).not.toBe(agentsText);
    expect(findModelRoutingDrift(negated, routingText))
      .toContain("AGENTS.md must name docs/agent-graph/model-routing.yaml as the source of truth.");
  });

  it("detects a missing provider", () => {
    const [first, ...rest] = routingEntries;
    const { provider: _provider, ...withoutProvider } = first;
    expect(findModelRoutingDrift(agentsText, renderRouting([withoutProvider, ...rest])))
      .toContain("Routing entry 1 must have a non-empty string provider.");
  });

  it("detects a duplicate label", () => {
    expect(findModelRoutingDrift(agentsText, renderRouting([...routingEntries, entryFor("model:opus")])))
      .toContain("Duplicate routing label: model:opus.");
  });

  it("detects a renamed Opus model", () => {
    const renamed = routingEntries.map((entry) => (
      entry.label === "model:opus" ? { ...entry, model: "Claude Other" } : entry
    ));
    expect(findModelRoutingDrift(agentsText, renderRouting(renamed)))
      .toContain("Review model family missing from YAML: Opus.");
  });

  it("detects the Opus and Sonnet models swapped between their labels", () => {
    const swapped = routingEntries.map((entry) => {
      if (entry.label === "model:opus") return { ...entry, model: entryFor("model:sonnet").model };
      if (entry.label === "model:sonnet") return { ...entry, model: entryFor("model:opus").model };
      return entry;
    });
    const errors = findModelRoutingDrift(agentsText, renderRouting(swapped));
    expect(errors).toContain("Review model family missing from YAML: Opus.");
    expect(errors).toContain("Review model family missing from YAML: Sonnet.");
  });
});
