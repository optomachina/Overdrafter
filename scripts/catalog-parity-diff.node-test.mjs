import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureCatalogObjectDiffs, catalogPageQuery, catalogParityDiff, fetchCatalogRows } from "./catalog-parity-diff.mjs";

/** Exercises the JSON receipt wire format; structuredClone would skip serialization. */
function jsonReceiptRoundTrip(value) {
  const encoded = JSON.stringify(value);
  return JSON.parse(encoded);
}

test("records exact relation and function mismatch fields without losing raw ACL differences", () => {
  for (const category of ["relations", "functions"]) {
    const diff = catalogParityDiff(
      [{ identity: `${category}.one`, owner: "postgres", acl: "raw-a", normalizedGrants: ["a"] }],
      [{ identity: `${category}.one`, owner: "postgres", acl: "raw-b", normalizedGrants: ["a"] }],
    );
    assert.deepEqual(diff.differences[0].fields, ["acl"]);
    assert.deepEqual(jsonReceiptRoundTrip(diff).differences[0].source, { acl: "raw-a" });
  }
  const normalized = catalogParityDiff(
    [{ identity: "function", acl: "same", normalizedGrants: ["postgres:EXECUTE"] }],
    [{ identity: "function", acl: "same", normalizedGrants: ["anon:EXECUTE"] }],
  );
  assert.deepEqual(normalized.differences[0].fields, ["normalizedGrants"]);
  assert.deepEqual(jsonReceiptRoundTrip(normalized).differences[0].fixture,
    { normalizedGrants: ["anon:EXECUTE"] });
});

test("does not collapse duplicate catalog identities in serialized receipts", () => {
  const diff = catalogParityDiff(
    [{ identity: "membership", grantor: "a" }, { identity: "membership", grantor: "b" }],
    [{ identity: "membership", grantor: "a" }],
  );
  assert.equal(diff.sourceCount, 2);
  assert.equal(diff.fixtureCount, 1);
  assert.equal(jsonReceiptRoundTrip(diff).differences.length, 1);
});

test("records missing, extra and changed descriptors in every other parity category", () => {
  for (const category of ["schemas", "defaultPrivileges", "roles", "memberships", "roleSettings",
    "policies", "extensions", "extensionFunctions", "extensionRelations"]) {
    const diff = catalogParityDiff(
      [{ identity: `${category}.missing`, owner: "a" }, { identity: `${category}.changed`, owner: "a" }],
      [{ identity: `${category}.extra`, owner: "b" }, { identity: `${category}.changed`, owner: "b" }],
    );
    assert.deepEqual(diff.differences.map((row) => row.kind),
      ["changed", "extra-in-fixture", "missing-in-fixture"]);
    assert.deepEqual(diff.differences[0].fields, ["owner"]);
    assert.equal(jsonReceiptRoundTrip(diff).differences.length, 3);
  }
});

test("paginates diagnostic rows with a stable order and rejects unbounded pages", () => {
  const query = "select coalesce(json_agg(row_to_json(item) order by item.identity), '[]'::json) from (select 'one' as identity) item;";
  const page = catalogPageQuery(query, 100);
  assert.match(page, /order by item\.identity, row_to_json\(item\)::text/);
  assert.match(page, /limit 100 offset 100/);
  assert.throws(() => catalogPageQuery(query, 0, 101), /invalid_catalog_page_query/);
});

test("receipt keeps all eleven category diffs and a query failure", () => {
  const categories = ["schemas", "relations", "functions", "defaultPrivileges", "roles", "memberships",
    "roleSettings", "policies", "extensions", "extensionFunctions", "extensionRelations"];
  const queries = Object.fromEntries(categories.map((name) => [name, name]));
  const sourceRows = {
    schemas: { identity: "private", owner: "postgres", acl: "raw" },
    relations: { identity: '["public","parts","r"]', owner: "postgres", normalized_grants: ["authenticated:SELECT"] },
    functions: { identity: '["public","f","arg integer"]', body_md5: "a", configuration_md5: "safe-hash" },
    defaultPrivileges: { identity: "default", acl: "raw" },
    roles: { identity: "authenticated", rolcanlogin: false },
    memberships: { identity: "member", set_option: true },
    roleSettings: { identity: "setting", config_md5: "safe-hash" },
    policies: { identity: "policy", qual_md5: "a" },
    extensions: { identity: "extension", extversion: "1" },
    extensionFunctions: { identity: "extension-function" },
    extensionRelations: { identity: "extension-relation" },
  };
  const receipt = captureCatalogObjectDiffs(categories, queries, (name, source) => {
    if (name === "extensions") throw new Error("synthetic read failure");
    return source ? [sourceRows[name]] : [];
  });
  const serialized = jsonReceiptRoundTrip({ catalogObjectDiff: receipt });
  assert.deepEqual(Object.keys(serialized.catalogObjectDiff), categories);
  assert.equal(serialized.catalogObjectDiff.extensions.diagnosticError, "catalog_descriptor_capture_failed");
  for (const name of categories.filter((category) => category !== "extensions")) {
    assert.equal(serialized.catalogObjectDiff[name].differences[0].kind, "missing-in-fixture");
  }
  assert.equal(JSON.stringify(serialized).includes("synthetic read failure"), false);
  assert.equal(JSON.stringify(serialized).includes("safe-hash"), true);
});

test("retrieves every page and shrinks pages when a response exceeds its bound", () => {
  const query = "select coalesce(json_agg(row_to_json(item) order by item.identity), '[]'::json) from (select 'one' as identity) item;";
  const rows = Array.from({ length: 120 }, (_, index) => ({ identity: `row-${index}` }));
  const calls = [];
  const received = fetchCatalogRows(query, (_page, offset, limit) => {
    calls.push({ offset, limit });
    if (limit === 100) throw new Error("synthetic page too large");
    return rows.slice(offset, offset + limit);
  });
  assert.deepEqual(received, rows);
  assert.deepEqual(calls, [
    { offset: 0, limit: 100 }, { offset: 0, limit: 50 },
    { offset: 50, limit: 50 }, { offset: 100, limit: 50 },
  ]);
});

test("preserves earlier page identities when a later page cannot be read", () => {
  const query = "select coalesce(json_agg(row_to_json(item) order by item.identity), '[]'::json) from (select 'one' as identity) item;";
  const receipt = captureCatalogObjectDiffs(["functions"], { functions: query }, (sql) =>
    fetchCatalogRows(sql, (_page, offset) => {
      if (offset > 0) throw new Error("terminal synthetic page error");
      return Array.from({ length: 100 }, (_, index) => ({ identity: `function-${index}` }));
    }));
  const serialized = jsonReceiptRoundTrip(receipt);
  assert.equal(serialized.functions.diagnosticError, "catalog_descriptor_capture_failed");
  assert.equal(serialized.functions.interruptedSide, "source");
  assert.equal(serialized.functions.interruptedRows.length, 100);
  assert.deepEqual(serialized.functions.interruptedRows[0], { identity: "function-0" });
  assert.equal(JSON.stringify(serialized).includes("terminal synthetic page error"), false);
});

test("retains full source descriptors and partial fixture descriptors on later fixture failure", () => {
  const rows = Array.from({ length: 250 }, (_, index) => ({ identity: `f-${index}`, acl: `grant-${index}` }));
  const receipt = captureCatalogObjectDiffs(["functions"], { functions: "query" }, (_query, source) => {
    if (source) return rows;
    const error = new Error("fixture later page failed");
    error.partialRows = rows.slice(0, 200);
    throw error;
  });
  const parsed = jsonReceiptRoundTrip(receipt.functions);
  assert.equal(parsed.interruptedSide, "fixture");
  assert.equal(parsed.completeSourceRows.length, 250);
  assert.equal(parsed.interruptedRows.length, 200);
  assert.equal(parsed.completeSourceRows[249].acl, "grant-249");
  assert.equal(parsed.interruptedRows[199].acl, "grant-199");
});

test("an argument-name-only function identity change remains visible", () => {
  const diff = catalogParityDiff(
    [{ identity: '["public","f","before integer"]', body_md5: "same" }],
    [{ identity: '["public","f","after integer"]', body_md5: "same" }],
  );
  assert.deepEqual(diff.differences.map((row) => row.kind), ["extra-in-fixture", "missing-in-fixture"]);
});

test("runner's eleven descriptor queries produce a serialized synthetic mismatch receipt", () => {
  const runner = readFileSync(new URL("./test-sourcing-intent.mjs", import.meta.url), "utf8");
  const section = runner.slice(runner.indexOf("const objectDetails = {"),
    runner.indexOf("if (JSON.stringify(Object.keys(objectDetails).sort())"));
  const queries = Object.fromEntries([...section.matchAll(/^ {6}(\w+): (?:String\.raw)?`([^`]*)`,/gm)]
    .map((match) => [match[1], match[2]]));
  queries.schemas = runner.match(/const schemaDetails = `([\s\S]*?)`;/)?.[1];
  const categories = ["schemas", "relations", "functions", "defaultPrivileges", "roles", "memberships",
    "roleSettings", "policies", "extensions", "extensionFunctions", "extensionRelations"];
  assert.deepEqual(Object.keys(queries).sort((left, right) => left.localeCompare(right)), [...categories].sort((left, right) => left.localeCompare(right)));
  assert.match(queries.functions, /pg_get_function_identity_arguments\(p\.oid\)/);
  assert.match(queries.functions, /md5\(coalesce\(p\.proconfig::text,''\)\)/);
  assert.match(queries.roleSettings, /md5\(s\.setconfig::text\)/);
  assert.match(queries.policies, /md5\(coalesce\(qual,''\)\)/);
  assert.doesNotMatch(queries.functions, /p\.proconfig::text as configuration/);
  const receipt = captureCatalogObjectDiffs(categories, queries, (query, source) => {
    const category = Object.entries(queries).find(([, candidate]) => candidate === query)?.[0];
    assert.ok(category);
    return source ? [{ identity: `["${category}","object"]`, owner: "postgres", acl: "raw-grant" }] : [];
  });
  const directory = mkdtempSync(join(tmpdir(), "ovd570-catalog-receipt-test-"));
  try {
    const path = join(directory, "receipt.json");
    writeFileSync(path, JSON.stringify({ catalogObjectDiff: receipt }));
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(Object.keys(persisted.catalogObjectDiff), categories);
    for (const category of categories) {
      assert.equal(persisted.catalogObjectDiff[category].differences[0].source.acl, "raw-grant");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid response and row limit retain complete earlier descriptor pages", () => {
  const query = "select coalesce(json_agg(row_to_json(item) order by item.identity), '[]'::json) from (select 'one' as identity) item;";
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ identity: `row-${index}`, acl: `grant-${index}` }));
  const cases = [
    { executePage: (_sql, offset) => offset === 0 ? firstPage : new Array(101).fill({ identity: "bad" }), maxRows: 200 },
    { executePage: () => firstPage, maxRows: 100 },
  ];
  for (const { executePage, maxRows } of cases) {
    const receipt = captureCatalogObjectDiffs(["relations"], { relations: query }, () =>
      fetchCatalogRows(query, executePage, maxRows));
    const serialized = jsonReceiptRoundTrip({ catalogObjectDiff: receipt });
    const failure = serialized.catalogObjectDiff.relations;
    assert.equal(failure.diagnosticError, "catalog_descriptor_capture_failed");
    assert.equal(failure.interruptedSide, "source");
    assert.equal(failure.interruptedRows.length, 100);
    assert.equal(failure.interruptedRows[99].acl, "grant-99");
  }
});
