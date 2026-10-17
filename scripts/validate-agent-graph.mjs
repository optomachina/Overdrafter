#!/usr/bin/env node
// Validates docs/agent-graph/graph.v1.yaml (JSON-subset YAML) against graph.schema.json
// and checks graph integrity. Dependency-free: supports the schema keywords used there.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "docs/agent-graph");

function check(schema, value, at, defs, errors) {
  if (schema.$ref) schema = defs[schema.$ref.replace("#/$defs/", "")];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: must be one of ${schema.enum.join(", ")}`);
  const t = schema.type;
  const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  if (t && t !== actual) { errors.push(`${at}: expected ${t}, got ${actual}`); return; }
  if (actual === "object") {
    for (const k of schema.required ?? []) if (!(k in value)) errors.push(`${at}: missing ${k}`);
    for (const [k, v] of Object.entries(value)) {
      const sub = schema.properties?.[k] ?? (typeof schema.additionalProperties === "object" ? schema.additionalProperties : null);
      if (sub) check(sub, v, `${at}.${k}`, defs, errors);
      else if (schema.additionalProperties === false) errors.push(`${at}: unknown key ${k}`);
    }
  }
  if (actual === "array" && schema.items) value.forEach((v, i) => check(schema.items, v, `${at}[${i}]`, defs, errors));
}

export function validateGraph(graph, schema) {
  const errors = [];
  check(schema, graph, "graph", schema.$defs ?? {}, errors);
  if (errors.length) return errors;
  const nodes = new Set(Object.keys(graph.nodes));
  if (!nodes.has(graph.root)) errors.push(`root ${graph.root} is not a node`);
  graph.edges.forEach((e, i) => {
    for (const k of ["from", "to", "else"]) if (e[k] !== undefined && !nodes.has(e[k])) errors.push(`edges[${i}].${k}: unknown node ${e[k]}`);
    for (const p of [...(e.when ?? []), ...(e.unless ?? [])]) if (!(p in graph.predicates)) errors.push(`edges[${i}]: undeclared predicate ${p}`);
    if (e.else !== undefined && !e.when && !e.unless) errors.push(`edges[${i}]: else without a condition`);
  });
  const verifiers = Object.values(graph.nodes).filter((n) => n.role === "verifier");
  if (!verifiers.length || verifiers.some((n) => n.must_not_author !== true)) errors.push("every verifier must set must_not_author: true");
  // Count only reviewers on the default path: unconditional edges out of jev. Overflow or risk-gated reviewers don't count.
  const defaultReviewers = graph.edges
    .filter((e) => e.from === "jev" && !e.when && !e.unless && graph.nodes[e.to]?.role === "reviewer")
    .map((e) => graph.nodes[e.to]);
  const families = new Set(defaultReviewers.map((n) => n.family));
  if (families.size < 2) errors.push("default-path reviewers (unconditional jev edges) must span at least two model families");
  const rules = graph.runtime_routing?.usage_balancer?.rules ?? [];
  const ruleIds = new Set();
  for (const r of rules) {
    if (ruleIds.has(r.id)) errors.push(`usage_balancer: duplicate rule id ${r.id}`);
    ruleIds.add(r.id);
    if (!r.rule.trim()) errors.push(`usage_balancer: rule ${r.id} has empty text`);
  }
  for (const r of rules) for (const o of r.overrides ?? []) if (!ruleIds.has(o)) errors.push(`usage_balancer: rule ${r.id} overrides unknown rule ${o}`);
  const overrides = new Map(rules.map((r) => [r.id, r.overrides ?? []]));
  const state = new Map();
  const visit = (id, trail) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "open") { errors.push(`usage_balancer: override cycle ${[...trail, id].join(" -> ")}`); return; }
    state.set(id, "open");
    for (const o of overrides.get(id) ?? []) if (overrides.has(o)) visit(o, [...trail, id]);
    state.set(id, "done");
  };
  for (const id of overrides.keys()) visit(id, []);
  return errors;
}

export function loadGraph() {
  return {
    graph: JSON.parse(readFileSync(path.join(dir, "graph.v1.yaml"), "utf8")),
    schema: JSON.parse(readFileSync(path.join(dir, "graph.schema.json"), "utf8")),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { graph, schema } = loadGraph();
  const errors = validateGraph(graph, schema);
  if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
  console.log(`agent graph ok: ${Object.keys(graph.nodes).length} nodes, ${graph.edges.length} edges`);
}
