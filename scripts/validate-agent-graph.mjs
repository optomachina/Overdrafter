#!/usr/bin/env node
// Validates docs/agent-graph/graph.v1.yaml (JSON-subset YAML) against graph.schema.json, then checks edge
// references, declared predicates, nodes with no edges, verifier and reviewer rules, and usage balancer rule
// precedence. It does not check reachability or dead ends. Dependency-free: it evaluates only the schema
// keywords listed below and rejects any other keyword, so a keyword added to the schema later fails loudly
// instead of being silently ignored.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "docs/agent-graph");

const EVALUATED_KEYWORDS = ["$ref", "type", "enum", "required", "properties", "additionalProperties", "items"];
const ANNOTATION_KEYWORDS = ["$schema", "$id", "$defs", "$comment", "title", "description"];
const SUPPORTED_KEYWORDS = new Set([...EVALUATED_KEYWORDS, ...ANNOTATION_KEYWORDS]);

function subSchemas(schema) {
  const subs = [...Object.entries(schema.properties ?? {}), ...Object.entries(schema.$defs ?? {})];
  if (schema.items) subs.push(["items", schema.items]);
  if (typeof schema.additionalProperties === "object") subs.push(["additionalProperties", schema.additionalProperties]);
  return subs;
}

function schemaKeywordErrors(schema, at, errors) {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(key)) errors.push(`${at}: unsupported schema keyword ${key}`);
  }
  for (const [name, sub] of subSchemas(schema)) schemaKeywordErrors(sub, `${at}.${name}`, errors);
}

function jsonType(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function propertySchema(schema, key) {
  if (schema.properties?.[key]) return schema.properties[key];
  return typeof schema.additionalProperties === "object" ? schema.additionalProperties : null;
}

function checkObject(schema, value, at, defs, errors) {
  for (const k of schema.required ?? []) if (!(k in value)) errors.push(`${at}: missing ${k}`);
  for (const [k, v] of Object.entries(value)) {
    const sub = propertySchema(schema, k);
    if (sub) check(sub, v, `${at}.${k}`, defs, errors);
    else if (schema.additionalProperties === false) errors.push(`${at}: unknown key ${k}`);
  }
}

function check(rawSchema, value, at, defs, errors) {
  const schema = rawSchema.$ref ? defs[rawSchema.$ref.replace("#/$defs/", "")] : rawSchema;
  if (!schema) {
    errors.push(`${at}: unresolved $ref ${rawSchema.$ref}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: must be one of ${schema.enum.join(", ")}`);
  const actual = jsonType(value);
  if (schema.type && schema.type !== actual) {
    errors.push(`${at}: expected ${schema.type}, got ${actual}`);
    return;
  }
  if (actual === "object") checkObject(schema, value, at, defs, errors);
  if (actual === "array" && schema.items) value.forEach((v, i) => check(schema.items, v, `${at}[${i}]`, defs, errors));
}

function rootErrors(graph) {
  return Object.hasOwn(graph.nodes, graph.root) ? [] : [`root ${graph.root} is not a node`];
}

function edgeNodeErrors(edge, index, nodes) {
  return ["from", "to", "else"]
    .filter((k) => edge[k] !== undefined && !nodes.has(edge[k]))
    .map((k) => `edges[${index}].${k}: unknown node ${edge[k]}`);
}

function edgePredicateErrors(edge, index, predicates) {
  return [...(edge.when ?? []), ...(edge.unless ?? [])]
    .filter((p) => !Object.hasOwn(predicates, p))
    .map((p) => `edges[${index}]: undeclared predicate ${p}`);
}

function elseErrors(edge, index) {
  const unconditional = !edge.when && !edge.unless;
  return edge.else !== undefined && unconditional ? [`edges[${index}]: else without a condition`] : [];
}

function edgeErrors(graph) {
  const nodes = new Set(Object.keys(graph.nodes));
  return graph.edges.flatMap((edge, i) => [
    ...edgeNodeErrors(edge, i, nodes),
    ...edgePredicateErrors(edge, i, graph.predicates),
    ...elseErrors(edge, i),
  ]);
}

// A node that no edge names can never receive or hand off work. The root is the only node allowed to have no edges.
function orphanErrors(graph) {
  const linked = new Set(graph.edges.flatMap((e) => [e.from, e.to, e.else]));
  return Object.keys(graph.nodes)
    .filter((id) => id !== graph.root && !linked.has(id))
    .map((id) => `node ${id} has no edges`);
}

function verifierErrors(graph) {
  const verifiers = Object.values(graph.nodes).filter((n) => n.role === "verifier");
  const ok = verifiers.length > 0 && verifiers.every((n) => n.must_not_author === true);
  return ok ? [] : ["every verifier must set must_not_author: true"];
}

// Count only reviewers on the default path: unconditional edges out of jev. Overflow or risk-gated reviewers
// don't count, and a reviewer with no family is an error, never a family of its own.
function reviewerErrors(graph) {
  const missing = Object.entries(graph.nodes)
    .filter(([, n]) => n.role === "reviewer" && !n.family)
    .map(([id]) => `reviewer ${id} must set family`);
  const defaultReviewers = graph.edges
    .filter((e) => e.from === "jev" && !e.when && !e.unless && graph.nodes[e.to]?.role === "reviewer")
    .map((e) => graph.nodes[e.to]);
  const families = new Set(defaultReviewers.map((n) => n.family).filter(Boolean));
  const spread = families.size < 2 ? ["default-path reviewers (unconditional jev edges) must span at least two model families"] : [];
  return [...missing, ...spread];
}

function ruleTextErrors(rules) {
  const errors = [];
  const seen = new Set();
  for (const r of rules) {
    if (seen.has(r.id)) errors.push(`usage_balancer: duplicate rule id ${r.id}`);
    seen.add(r.id);
    if (!r.rule.trim()) errors.push(`usage_balancer: rule ${r.id} has empty text`);
  }
  return errors;
}

function unknownOverrideErrors(rules) {
  const ids = new Set(rules.map((r) => r.id));
  return rules.flatMap((r) => (r.overrides ?? []).filter((o) => !ids.has(o)).map((o) => `usage_balancer: rule ${r.id} overrides unknown rule ${o}`));
}

function visitOverride(id, trail, overrides, state, errors) {
  if (state.get(id) === "done") return;
  if (state.get(id) === "open") {
    errors.push(`usage_balancer: override cycle ${[...trail, id].join(" -> ")}`);
    return;
  }
  state.set(id, "open");
  for (const o of overrides.get(id) ?? []) if (overrides.has(o)) visitOverride(o, [...trail, id], overrides, state, errors);
  state.set(id, "done");
}

function overrideCycleErrors(rules) {
  const errors = [];
  const overrides = new Map(rules.map((r) => [r.id, r.overrides ?? []]));
  const state = new Map();
  for (const id of overrides.keys()) visitOverride(id, [], overrides, state, errors);
  return errors;
}

function balancerErrors(graph) {
  const rules = graph.runtime_routing?.usage_balancer?.rules ?? [];
  return [...ruleTextErrors(rules), ...unknownOverrideErrors(rules), ...overrideCycleErrors(rules)];
}

export function validateGraph(graph, schema) {
  const keywordErrors = [];
  schemaKeywordErrors(schema, "schema", keywordErrors);
  if (keywordErrors.length) return keywordErrors;
  const errors = [];
  check(schema, graph, "graph", schema.$defs ?? {}, errors);
  if (errors.length) return errors;
  return [
    ...rootErrors(graph),
    ...edgeErrors(graph),
    ...orphanErrors(graph),
    ...verifierErrors(graph),
    ...reviewerErrors(graph),
    ...balancerErrors(graph),
  ];
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
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }
  console.log(`agent graph ok: ${Object.keys(graph.nodes).length} nodes, ${graph.edges.length} edges`);
}
