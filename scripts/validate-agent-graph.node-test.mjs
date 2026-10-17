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
