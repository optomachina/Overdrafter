#!/usr/bin/env node
/**
 * OVD-602 inventory diff. Compares a privilege inventory (output of
 * scripts/window-1/ovd602-inventory.sql) against a pinned inventory, so any
 * new SECURITY DEFINER function, EXECUTE grant, table grant, RLS flag or policy
 * shows up as an explicit, reviewable diff. Reads files only; never connects to
 * a database.
 *
 *   node scripts/window-1/ovd602-diff.mjs <pin.json> <current.json>
 *       [--expect <expected-diff.json>] [--write-diff <out.json>] [--json]
 *   node scripts/window-1/ovd602-diff.mjs --normalize <raw.json> <out.json>
 *
 * Exit 0: no difference, or the difference equals --expect exactly.
 * Exit 1: an unexpected difference (printed). Exit 2: usage or input error.
 */
import { isEntryPoint } from "../lib/entry-point.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** Code unit order, the same order Array#sort uses without a comparator, made explicit. */
export const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export const INVENTORY_FORMAT = "ovd602.inventory.v1";
export const DIFF_FORMAT = "ovd602.diff.v1";
const API_ROLES = ["PUBLIC", "anon", "authenticated"];

const SECTIONS = {
  schemas: (entry) => entry.name,
  functions: (entry) => entry.signature,
  relations: (entry) => entry.name,
  policies: (entry) => `${entry.table} ${entry.name}`,
};

export function parseInventory(text, label = "inventory") {
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not JSON: ${error.message}`);
  }
  if (value?.format !== INVENTORY_FORMAT) {
    throw new Error(`${label} format must be ${INVENTORY_FORMAT}`);
  }
  for (const section of Object.keys(SECTIONS)) {
    if (!Array.isArray(value[section])) throw new Error(`${label} is missing ${section}`);
  }
  return value;
}

/** One entry per line, sorted, so a pin change reads as a small git diff. */
export function formatInventory(inventory) {
  const lines = [`{"format":${JSON.stringify(INVENTORY_FORMAT)},`];
  const names = Object.keys(SECTIONS);
  names.forEach((section, index) => {
    const key = SECTIONS[section];
    const entries = [...inventory[section]].sort((a, b) => key(a).localeCompare(key(b)));
    lines.push(`${JSON.stringify(section)}:[`);
    entries.forEach((entry, i) => lines.push(`${JSON.stringify(canonical(entry))}${i < entries.length - 1 ? "," : ""}`));
    lines.push(`]${index < names.length - 1 ? "," : ""}`);
  });
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort(byCodeUnit).map((k) => [k, canonical(value[k])]));
  }
  return value;
}

const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

export function diffInventories(pin, current) {
  const diff = { format: DIFF_FORMAT, added: {}, removed: {}, changed: {} };
  for (const [section, key] of Object.entries(SECTIONS)) {
    const before = new Map(pin[section].map((e) => [key(e), e]));
    const after = new Map(current[section].map((e) => [key(e), e]));
    const added = [...after.keys()].filter((k) => !before.has(k)).sort(byCodeUnit).map((k) => canonical(after.get(k)));
    const removed = [...before.keys()].filter((k) => !after.has(k)).sort(byCodeUnit).map((k) => canonical(before.get(k)));
    const changed = [...after.keys()]
      .filter((k) => before.has(k) && !same(before.get(k), after.get(k)))
      .sort(byCodeUnit)
      .map((k) => ({ key: k, from: canonical(before.get(k)), to: canonical(after.get(k)) }));
    if (added.length) diff.added[section] = added;
    if (removed.length) diff.removed[section] = removed;
    if (changed.length) diff.changed[section] = changed;
  }
  diff.flags = flagsFor(diff);
  return diff;
}

/** Review flags: facts a window reviewer must explicitly accept. */
export function flagsFor(diff) {
  const flags = [];
  const fns = [
    ...(diff.added.functions ?? []).map((f) => ["added", f]),
    ...(diff.changed.functions ?? []).map((c) => ["changed", c.to]),
  ];
  for (const [how, f] of fns) {
    if (f.definer && !f.search_path) flags.push(`DEFINER_WITHOUT_SEARCH_PATH ${how} ${f.signature}`);
    if (f.definer && f.search_path && f.search_path.replace(/["\s]/g, "") !== "") {
      flags.push(`DEFINER_NONEMPTY_SEARCH_PATH ${how} ${f.signature} search_path=${f.search_path}`);
    }
    const exposed = f.execute.filter((r) => API_ROLES.includes(r));
    if (f.definer && exposed.length) flags.push(`DEFINER_EXECUTABLE_BY ${exposed.join(",")} ${how} ${f.signature}`);
  }
  const rels = [
    ...(diff.added.relations ?? []).map((r) => ["added", r]),
    ...(diff.changed.relations ?? []).map((c) => ["changed", c.to]),
  ];
  for (const [how, r] of rels) {
    const exposed = API_ROLES.filter((role) => (r.grants[role] ?? []).length);
    if (exposed.length) flags.push(`RELATION_GRANTED_TO ${exposed.join(",")} ${how} ${r.name}`);
    if ((r.kind === "r" || r.kind === "p") && !r.rls) flags.push(`RLS_DISABLED ${how} ${r.name}`);
  }
  for (const c of diff.changed.policies ?? []) flags.push(`POLICY_CHANGED ${c.key}`);
  for (const p of diff.removed.policies ?? []) flags.push(`POLICY_REMOVED ${p.table} ${p.name}`);
  return flags.sort(byCodeUnit);
}

export function isEmptyDiff(diff) {
  return ["added", "removed", "changed"].every((k) => Object.keys(diff[k]).length === 0);
}

/** True when only one side's grants carry MAINTAIN (a PostgreSQL 17 privilege): a major version mismatch. */
export function maintainOnlyOnOneSide(pin, current) {
  const has = (inv) => inv.relations.some((r) => Object.values(r.grants).some((p) => p.includes("MAINTAIN")));
  return has(pin) !== has(current);
}

export function renderDiff(diff) {
  if (isEmptyDiff(diff)) return "ovd602: no difference from the pin\n";
  const out = [];
  for (const kind of ["added", "removed", "changed"]) {
    for (const [section, entries] of Object.entries(diff[kind])) {
      out.push(`${kind} ${section} (${entries.length}):`);
      for (const e of entries) {
        if (kind !== "changed") {
          out.push(`  ${SECTIONS[section](e)}  ${JSON.stringify(e)}`);
          continue;
        }
        const fields = Object.keys({ ...e.from, ...e.to }).filter((f) => !same(e.from[f], e.to[f]));
        out.push(`  ${e.key}`);
        for (const f of fields) out.push(`      ${f}: ${JSON.stringify(e.from[f])} -> ${JSON.stringify(e.to[f])}`);
      }
    }
  }
  out.push(`flags (${diff.flags.length}):`);
  for (const f of diff.flags) out.push(`  ${f}`);
  return `${out.join("\n")}\n`;
}

export function main(argv = process.argv.slice(2)) {
  const read = (path) => readFileSync(resolve(path), "utf8");
  if (argv[0] === "--normalize") {
    if (argv.length !== 3) throw new UsageError("--normalize <raw.json> <out.json>");
    writeFileSync(resolve(argv[2]), formatInventory(parseInventory(read(argv[1]), argv[1])));
    return 0;
  }
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--expect" || arg === "--write-diff") {
      if (!argv[i + 1]) throw new UsageError(`${arg} needs a path`);
      options[arg.slice(2)] = argv[(i += 1)];
    } else if (arg.startsWith("--")) throw new UsageError(`unknown option ${arg}`);
    else positional.push(arg);
  }
  if (positional.length !== 2) throw new UsageError("<pin.json> <current.json> are required");
  const pinInventory = parseInventory(read(positional[0]), positional[0]);
  const currentInventory = parseInventory(read(positional[1]), positional[1]);
  const diff = diffInventories(pinInventory, currentInventory);
  if (maintainOnlyOnOneSide(pinInventory, currentInventory)) {
    process.stderr.write("ovd602: only one side grants MAINTAIN (PostgreSQL 17). The two inventories come from different major versions; compare like with like.\n");
  }
  if (options["write-diff"]) writeFileSync(resolve(options["write-diff"]), `${JSON.stringify(diff, null, 2)}\n`);
  process.stdout.write(options.json ? `${JSON.stringify(diff, null, 2)}\n` : renderDiff(diff));
  if (options.expect) {
    const expected = JSON.parse(read(options.expect));
    if (same(expected, diff)) {
      process.stdout.write(`ovd602: difference matches ${options.expect} exactly\n`);
      return 0;
    }
    process.stdout.write(`ovd602: difference does NOT match ${options.expect}\n`);
    return 1;
  }
  return isEmptyDiff(diff) ? 0 : 1;
}

class UsageError extends Error {}

if (isEntryPoint(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`ovd602-diff: ${error.message}\n`);
    process.exitCode = 2;
  }
}
