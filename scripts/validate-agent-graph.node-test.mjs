import test from "node:test";
import assert from "node:assert/strict";
import { loadGraph, validateGraph } from "./validate-agent-graph.mjs";

const fresh = () => structuredClone(loadGraph());

test("canonical agent graph is valid", () => {
  const { graph, schema } = fresh();
  assert.deepEqual(validateGraph(graph, schema), []);
});

test("rejects an edge to an unknown node", () => {
  const { graph, schema } = fresh();
  graph.edges.push({ from: "qa", to: "ghost" });
  assert.match(validateGraph(graph, schema).join("\n"), /unknown node ghost/);
});

test("rejects an undeclared predicate", () => {
  const { graph, schema } = fresh();
  graph.edges.push({ from: "qa", to: "release", when: ["nope"] });
  assert.match(validateGraph(graph, schema).join("\n"), /undeclared predicate nope/);
});

test("rejects schema violations", () => {
  const { graph, schema } = fresh();
  graph.nodes.qa.role = "boss";
  assert.match(validateGraph(graph, schema).join("\n"), /must be one of/);
});

test("rejects a single reviewer family", () => {
  const { graph, schema } = fresh();
  for (const n of Object.values(graph.nodes)) if (n.role === "reviewer") n.family = "anthropic";
  assert.match(validateGraph(graph, schema).join("\n"), /two model families/);
});

test("a reviewer with no family is an error and never counts as a family", () => {
  const { graph, schema } = fresh();
  delete graph.nodes.codex.family;
  const errors = validateGraph(graph, schema).join("\n");
  assert.match(errors, /reviewer codex must set family/);
  // sonnet is the only default-path reviewer left with a family, so the two-family rule must still fail.
  assert.match(errors, /two model families/);
});

test("rejects a schema keyword the validator does not evaluate", () => {
  const { graph, schema } = fresh();
  schema.properties.nodes.minProperties = 1;
  assert.match(validateGraph(graph, schema).join("\n"), /schema\.nodes: unsupported schema keyword minProperties/);
});

test("rejects a $ref that does not resolve", () => {
  const { graph, schema } = fresh();
  schema.properties.nodes.additionalProperties = { $ref: "#/$defs/ghost" };
  assert.match(validateGraph(graph, schema).join("\n"), /unresolved \$ref #\/\$defs\/ghost/);
});

test("rejects a node that no edge names, but not the root", () => {
  const { graph, schema } = fresh();
  assert.deepEqual(graph.edges.filter((e) => [e.from, e.to].includes(graph.root)), []);
  graph.nodes.stray = { role: "writer" };
  assert.deepEqual(validateGraph(graph, schema), ["node stray has no edges"]);
});

test("requires the merge gate pointers and runtime routing", () => {
  for (const [path, pattern] of [
    [["merge_gate", "auto_merge_allowlist"], /merge_gate: missing auto_merge_allowlist/],
    [["merge_gate", "sensitive_paths"], /merge_gate: missing sensitive_paths/],
    [["merge_gate", "auto_merge_also_requires"], /merge_gate: missing auto_merge_also_requires/],
    [["runtime_routing"], /graph: missing runtime_routing/],
  ]) {
    const { graph, schema } = fresh();
    const parent = path.slice(0, -1).reduce((node, key) => node[key], graph);
    delete parent[path.at(-1)];
    assert.match(validateGraph(graph, schema).join("\n"), pattern, path.join("."));
  }
});

test("overflow reviewer does not count toward the two-family rule", () => {
  const { graph, schema } = fresh();
  graph.nodes.codex.family = "anthropic";
  assert.equal(graph.nodes.grok.family, "xai");
  assert.match(validateGraph(graph, schema).join("\n"), /two model families/);
});

test("caps override every assignment rule", () => {
  const { graph } = fresh();
  const byId = Object.fromEntries(graph.runtime_routing.usage_balancer.rules.map((r) => [r.id, r]));
  for (const cap of ["weekly-review-only", "five-hour-no-builds"])
    for (const target of ["build-furthest-behind-pace", "burn-before-reset"]) assert.ok(byId[cap].overrides.includes(target), `${cap} overrides ${target}`);
});

test("rejects an override cycle", () => {
  const { graph, schema } = fresh();
  graph.runtime_routing.usage_balancer.rules[2].overrides = ["weekly-review-only"];
  assert.match(validateGraph(graph, schema).join("\n"), /override cycle/);
});

test("usage balancer rules are present, unique and override known rules", () => {
  const { graph, schema } = fresh();
  const ids = graph.runtime_routing.usage_balancer.rules.map((r) => r.id);
  assert.deepEqual(ids, ["jev-first", "build-furthest-behind-pace", "burn-before-reset", "weekly-review-only", "five-hour-no-builds", "skip-no-data"]);
  graph.runtime_routing.usage_balancer.rules[3].overrides = ["ghost-rule"];
  assert.match(validateGraph(graph, schema).join("\n"), /overrides unknown rule ghost-rule/);
});

test("rejects a usage balancer rule with no text or an unknown key", () => {
  const { graph, schema } = fresh();
  delete graph.runtime_routing.usage_balancer.rules[0].rule;
  graph.runtime_routing.usage_balancer.rules[1].weight = 2;
  const errors = validateGraph(graph, schema).join("\n");
  assert.match(errors, /missing rule/);
  assert.match(errors, /unknown key weight/);
});

test("qa verdict reuse requires an equal recomputed diff_id and rejects reuse when it cannot be computed", () => {
  for (const [mutate, pattern] of [
    [(qa) => (qa.rebase_reuse = "patch-id-equal"), /verdicts\.qa\.rebase_reuse/],
    [(qa) => delete qa.rebase_reuse, /verdicts\.qa\.rebase_reuse/],
    [(qa) => delete qa.rebase_reuse_on_error, /verdicts\.qa\.rebase_reuse_on_error/],
    [(qa) => (qa.rebase_reuse_on_error = "patch-id-equal"), /verdicts\.qa\.rebase_reuse_on_error/],
  ]) {
    const { graph, schema } = fresh();
    mutate(graph.verdicts.qa);
    assert.match(validateGraph(graph, schema).join("\n"), pattern, mutate.toString());
  }
});

test("rejects a graph with no qa verdict", () => {
  const { graph, schema } = fresh();
  delete graph.verdicts.qa;
  assert.match(validateGraph(graph, schema).join("\n"), /verdicts\.qa/);
});

test("rejects a graph missing a mandatory route", () => {
  for (const [match, pattern] of [
    [(e) => e.from === "jev" && e.to === "opus" && e.when?.includes("sensitive-paths"), /jev -> opus when sensitive-paths/],
    [(e) => e.from === "auto-triage", /auto-triage -> engineer unless sensitive-paths else release/],
    [(e) => e.from === "qa" && e.to === "merge-gate", /qa -> merge-gate/],
    [(e) => e.from === "merge-gate", /merge-gate -> release when protected/],
  ]) {
    const { graph, schema } = fresh();
    graph.edges = graph.edges.filter((e) => !match(e));
    assert.match(validateGraph(graph, schema).join("\n"), pattern, pattern.source);
  }
});

test("a mandatory route with an extra condition does not count", () => {
  const { graph, schema } = fresh();
  graph.edges.find((e) => e.from === "jev" && e.to === "opus" && e.when?.includes("sensitive-paths")).when.push("jev-risky");
  assert.match(validateGraph(graph, schema).join("\n"), /missing mandatory route jev -> opus when sensitive-paths/);
});

test("rejects an empty or incomplete merge gate", () => {
  for (const [key, mutate, pattern] of [
    ["requires", (g) => (g.requires = []), /merge_gate\.requires must include ci_green/],
    ["requires", (g) => (g.requires = g.requires.filter((r) => r !== "qa_PASS_or_PASS_NOTES_at_head")), /merge_gate\.requires must include qa_PASS_or_PASS_NOTES_at_head/],
    ["auto_merge_also_requires", (g) => (g.auto_merge_also_requires = []), /merge_gate\.auto_merge_also_requires must include jev_not_risky/],
  ]) {
    const { graph, schema } = fresh();
    mutate(graph.merge_gate);
    assert.match(validateGraph(graph, schema).join("\n"), pattern, key);
  }
});

test("an event-gated reviewer edge does not count toward the two-family rule", () => {
  for (const key of ["trigger", "gate"]) {
    const { graph, schema } = fresh();
    graph.edges.find((e) => e.from === "jev" && e.to === "codex")[key] = "pull_request.labeled";
    assert.match(validateGraph(graph, schema).join("\n"), /two model families/, key);
  }
});

test("rejects a $ref with a sibling constraint", () => {
  const { graph, schema } = fresh();
  schema.properties.nodes.additionalProperties = { $ref: "#/$defs/node", required: ["family"] };
  assert.match(validateGraph(graph, schema).join("\n"), /\$ref with sibling keyword required/);
});

test("rejects a chained $ref", () => {
  const { graph, schema } = fresh();
  schema.$defs.alias = { $ref: "#/$defs/node" };
  schema.properties.nodes.additionalProperties = { $ref: "#/$defs/alias" };
  assert.match(validateGraph(graph, schema).join("\n"), /chained \$ref #\/\$defs\/alias/);
});

test("rejects a chained $ref that ends unresolved", () => {
  const { graph, schema } = fresh();
  schema.$defs.alias = { $ref: "#/$defs/ghost" };
  schema.properties.nodes.additionalProperties = { $ref: "#/$defs/alias" };
  const errors = validateGraph(graph, schema).join("\n");
  assert.match(errors, /chained \$ref #\/\$defs\/alias/);
  assert.match(errors, /unresolved \$ref #\/\$defs\/ghost/);
});
