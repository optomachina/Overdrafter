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
