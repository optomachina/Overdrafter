import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { exerciseGateFixtures, diffEventMatrix, parseWorkflow } from "./ovd-merge-gate-event-matrix.mjs";
import { riskyRootCoverageErrors, testDeterminismErrors, validateAgentContract, NON_SENSITIVE_ALLOWLIST } from "./validate-agent-contract.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("current agent contract is internally consistent", () => {
  assert.deepEqual(validateAgentContract(repoRoot), []);
});

test("obsolete complexity approval and workflow settings are rejected", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-contract-"));
  try {
    fs.mkdirSync(path.join(temp, "docs"));
    for (const file of ["AGENTS.md", "CLAUDE.md", "WORKFLOW.md", "docs/sensitive-paths.json"]) {
      fs.copyFileSync(path.join(repoRoot, file), path.join(temp, file));
    }
    fs.appendFileSync(path.join(temp, "AGENTS.md"), "\nHigh-complexity override\n");
    fs.appendFileSync(path.join(temp, "WORKFLOW.md"), "\ngpt-5.3-codex\n");
    const errors = validateAgentContract(temp);
    assert.ok(errors.some((error) => error.includes("obsolete gate")));
    assert.ok(errors.some((error) => error.includes("obsolete model")));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("a new scripts file must be classified or allow-listed", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-contract-risky-"));
  const allow = path.join(temp, NON_SENSITIVE_ALLOWLIST);
  fs.mkdirSync(path.dirname(allow), { recursive: true });
  fs.mkdirSync(path.join(temp, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(temp, "scripts/new-tool.mjs"), "export {}\n");
  const classify = (file) => (file === NON_SENSITIVE_ALLOWLIST ? ["infra_ci"] : []);
  fs.writeFileSync(allow, JSON.stringify({ version: 1, paths: [] }));
  const uncovered = riskyRootCoverageErrors(temp, { classify });
  assert.ok(uncovered.some((error) => error.includes("scripts/new-tool.mjs")));
  fs.writeFileSync(allow, JSON.stringify({ version: 1, paths: ["scripts/new-tool.mjs"] }));
  assert.deepEqual(riskyRootCoverageErrors(temp, { classify }), []);
  fs.mkdirSync(path.join(temp, ".github/workflows"), { recursive: true });
  fs.writeFileSync(path.join(temp, ".github/workflows/new-gate.yml"), "on:\n  push:\n");
  const workflow = riskyRootCoverageErrors(temp, { classify });
  assert.ok(workflow.some((error) => error.includes(".github/workflows/new-gate.yml")));
  assert.ok(workflow.some((error) => error.includes("no allow-list")));
});

test("an unanchored digit LIKE or a real fsync fails the contract", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-contract-flake-"));
  const sql = path.join(temp, "supabase/tests/sample.sql");
  fs.mkdirSync(path.dirname(sql), { recursive: true });
  fs.writeFileSync(sql, "select decision::text not like '%" + "7075%';\n");
  assert.ok(testDeterminismErrors(temp).some((error) => error.includes("sample.sql")));
  fs.writeFileSync(sql, "select decision::text !~ '\\\\m7075\\\\M';\n");
  const unit = path.join(temp, "scripts/sample.test.mjs");
  fs.mkdirSync(path.dirname(unit), { recursive: true });
  fs.writeFileSync(unit, "await handle.syn" + "c();\n");
  assert.ok(testDeterminismErrors(temp).some((error) => error.includes("sample.test.mjs")));
  fs.writeFileSync(unit, "vi.spyOn(proto, \"sync\").mockImplementation(() => Promise.resolve());\nawait handle.syn" + "c();\n");
  assert.deepEqual(testDeterminismErrors(temp), []);
});

test("a new merge_group workflow must be added to the event matrix", () => {
  const file = ".github/workflows/new-gate.yml";
  const errors = diffEventMatrix({
    files: [{
      file,
      events: ["merge_group"],
      mergeGroupTypes: ["checks_requested"],
      text: "on:\n  merge_group:\n    types:\n      - checks_requested\n",
    }],
    matrix: { version: 1, workflows: [] },
    requiredWorkflows: [],
    commentFilter: "unused",
    doc: "",
  });
  assert.ok(errors.some((error) => error.includes(file) && error.includes("missing")));
});

test("the gate event matrix rejects a push that scans open PRs without report-only", () => {
  const files = [{
    file: ".github/workflows/example.yml",
    events: ["push"],
    mergeGroupTypes: "absent",
    text: "on:\n  push:\n    branches: [main]\njobs:\n  check:\n    steps:\n      - run: node scripts/example.mjs --all\n",
  }];
  const matrix = { version: 1, workflows: [{ file: files[0].file, events: ["push"], push: "commit" }] };
  const errors = diffEventMatrix({ files, matrix, requiredWorkflows: [], commentFilter: "issue_comment", doc: files[0].file });
  assert.ok(errors.some((error) => error.includes("report-only")));
});

test("a workflow on: the matrix cannot read fails closed instead of reading as no triggers", () => {
  const matrix = { version: 1, workflows: [] };
  const run = (text) => diffEventMatrix({ files: [parseWorkflow(".github/workflows/w.yml", text)], matrix, requiredWorkflows: [], commentFilter: "unused", doc: "" });
  for (const text of [
    "on: [merge_group, pull_request]\njobs: {}\n",
    "on: push\njobs: {}\n",
    "on:\n    merge_group:\n      types: [checks_requested]\njobs: {}\n",
    "on:\n\tpush:\njobs: {}\n",
    "on:\n\njobs: {}\n",
  ]) {
    const errors = run(text);
    assert.ok(errors.some((error) => error.includes(".github/workflows/w.yml") && error.includes("write on: as a block")), `${JSON.stringify(text)} -> ${JSON.stringify(errors)}`);
  }
  // A quoted key, CRLF line endings and comments still parse, so the missing row is reported.
  for (const text of ["\"on\":\n  merge_group:\n    types: [checks_requested]\n", "on: # triggers\r\n  # queue\r\n  'merge_group':\r\n"]) {
    const parsed = parseWorkflow(".github/workflows/w.yml", text);
    assert.equal(parsed.parseError, null, text);
    assert.deepEqual(parsed.events, ["merge_group"]);
    assert.ok(run(text).some((error) => error.includes("missing from")), text);
  }
  assert.deepEqual(parseWorkflow(".github/workflows/s.yml", "on:\n  schedule:\n    - cron: '0 * * * *'\n").events, ["schedule"]);
});

test("OVD-1157: a leading BOM still parses, and a workflow with no top-level on: fails closed", () => {
  const matrix = { version: 1, workflows: [] };
  const bom = parseWorkflow(".github/workflows/w.yml", "﻿on:\n  merge_group:\n    types: [checks_requested]\njobs: {}\n");
  assert.equal(bom.parseError, null);
  assert.deepEqual(bom.events, ["merge_group"]);
  assert.deepEqual(bom.mergeGroupTypes, ["checks_requested"]);
  const bomErrors = diffEventMatrix({ files: [bom], matrix, requiredWorkflows: [], commentFilter: "unused", doc: "" });
  assert.ok(bomErrors.some((error) => error.includes("missing from")), JSON.stringify(bomErrors));
  for (const text of ["name: no triggers\njobs: {}\n", "", "﻿"]) {
    const parsed = parseWorkflow(".github/workflows/w.yml", text);
    assert.ok(parsed.parseError, JSON.stringify(text));
    const errors = diffEventMatrix({ files: [parsed], matrix, requiredWorkflows: [], commentFilter: "unused", doc: "" });
    assert.ok(errors.some((error) => error.includes(".github/workflows/w.yml") && error.includes("no top-level on:")), `${JSON.stringify(text)} -> ${JSON.stringify(errors)}`);
  }
});

test("OVD-1157: a CRLF required workflow keyed on head.sha passes the concurrency check", () => {
  const file = ".github/workflows/required.yml";
  const lf = [
    "on:",
    "  merge_group:",
    "    types: [checks_requested]",
    "concurrency:",
    "  group: required-${{ github.event.pull_request.head.sha || github.sha }}",
    "  cancel-in-progress: true",
    "jobs: {}",
    "",
  ].join("\n");
  const matrix = { version: 1, workflows: [{ file, events: ["merge_group"], mergeGroupTypes: ["checks_requested"], required: true }] };
  const run = (text) => diffEventMatrix({ files: [parseWorkflow(file, text)], matrix, requiredWorkflows: [file], commentFilter: "unused", doc: file });
  assert.deepEqual(run(lf), []);
  assert.deepEqual(run(lf.replaceAll("\n", "\r\n")), []);
  // A raw CRLF text handed straight to diffEventMatrix is read the same way.
  const raw = { file, events: ["merge_group"], mergeGroupTypes: ["checks_requested"], text: lf.replaceAll("\n", "\r\n"), parseError: null };
  assert.deepEqual(diffEventMatrix({ files: [raw], matrix, requiredWorkflows: [file], commentFilter: "unused", doc: file }), []);
  // Dropping head.sha is still an error with either line ending.
  const unkeyed = lf.replace("github.event.pull_request.head.sha || ", "");
  for (const text of [unkeyed, unkeyed.replaceAll("\n", "\r\n")]) {
    assert.ok(run(text).some((error) => error.includes("must key concurrency")), JSON.stringify(text));
  }
});

test("OVD-1157: merge_group with a trailing comment, trailing whitespace or an inline map reads its types", () => {
  const types = (text) => parseWorkflow(".github/workflows/w.yml", `on:\n${text}jobs: {}\n`);
  for (const text of [
    "  merge_group: # the queue\n    types: [checks_requested]\n",
    "  merge_group:   \n    types: [checks_requested]\n",
    "  merge_group:\t\n    types:\n      - checks_requested\n",
    "  'merge_group': # quoted\n    types: # one type\n      - checks_requested # the only one\n",
    "  merge_group: { types: [checks_requested] }\n",
    "  merge_group: {types: [checks_requested]} # inline\n",
    "  merge_group:\n    types: [checks_requested]\n  pull_request:\n",
    "  merge_group:\n    types:\n      - checks_requested\n  pull_request:\n",
  ]) {
    const parsed = types(text);
    assert.equal(parsed.parseError, null, JSON.stringify(text));
    assert.deepEqual(parsed.mergeGroupTypes, ["checks_requested"], JSON.stringify(text));
  }
  assert.equal(types("  merge_group: # no types\n").mergeGroupTypes, null);
  assert.equal(types("  merge_group: {}\n").mergeGroupTypes, null);
  // An inline value this module cannot read fails closed instead of reading as absent.
  const odd = types("  merge_group: checks_requested\n");
  assert.ok(odd.parseError, JSON.stringify(odd));
  // A paths filter behind a comment or inside an inline map is still caught.
  const file = ".github/workflows/w.yml";
  const matrix = { version: 1, workflows: [{ file, events: ["merge_group"], mergeGroupTypes: ["checks_requested"] }] };
  for (const text of [
    "  merge_group: # queue\n    types: [checks_requested]\n    paths: [src/**]\n",
    "  merge_group: { types: [checks_requested], paths-ignore: [docs/**] }\n",
  ]) {
    const errors = diffEventMatrix({ files: [types(text)], matrix, requiredWorkflows: [], commentFilter: "unused", doc: file });
    assert.ok(errors.some((error) => error.includes("filters merge_group with paths")), `${JSON.stringify(text)} -> ${JSON.stringify(errors)}`);
  }
});

test("OVD-1157: the fsync lint ignores fast-glob and cross-spawn .sync( calls", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-contract-fsync-like-"));
  try {
    const unit = path.join(temp, "scripts/glob.test.mjs");
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, "const files = fg.sync([\"**/*.ts\"], { cwd });\nconst result = spawn.sync(\"git\", [\"status\"]);\nconst g = glob.sync(pattern);\n");
    assert.deepEqual(testDeterminismErrors(temp), []);
    // FileHandle sync and datasync take no arguments; those still fail, with or without spaces or optional chaining.
    for (const call of ["await handle.syn" + "c();\n", "await handle?.syn" + "c( );\n", "await fh.datasyn" + "c();\n"]) {
      fs.writeFileSync(unit, call);
      assert.ok(testDeterminismErrors(temp).some((error) => error.includes("scripts/glob.test.mjs")), call);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("a callback fsync and a worker test are covered by the fsync lint", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-contract-fsync-"));
  const unit = path.join(temp, "scripts/cb.test.mjs");
  fs.mkdirSync(path.dirname(unit), { recursive: true });
  fs.writeFileSync(unit, "fs.fsyn" + "c(fd, done);\n");
  assert.ok(testDeterminismErrors(temp).some((error) => error.includes("scripts/cb.test.mjs")));
  fs.writeFileSync(unit, "vi.spyOn(fs, \"fsync\").mockImplementation((fd, cb) => cb());\nfs.fsyn" + "c(fd, done);\n");
  assert.deepEqual(testDeterminismErrors(temp), []);
  const worker = path.join(temp, "worker/src/disk.test.ts");
  fs.mkdirSync(path.dirname(worker), { recursive: true });
  fs.writeFileSync(worker, "await handle.syn" + "c();\n");
  assert.ok(testDeterminismErrors(temp).some((error) => error.includes("worker/src/disk.test.ts")));
});

test("gate event fixtures match the merge-gate client", async () => {
  assert.deepEqual(await exerciseGateFixtures(repoRoot), []);
});

test("runs as a CLI when invoked through a symlinked directory", () => {
  // node runs a symlinked script from its real path; the entry guard compares realpaths.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-contract-link-"));
  try {
    const link = path.join(temp, "repo");
    fs.symlinkSync(repoRoot, link, "dir");
    const proc = spawnSync(process.execPath, [path.join(link, "scripts", "validate-agent-contract.mjs")], { encoding: "utf8" });
    assert.equal(proc.status, 0, proc.stderr);
    assert.equal(proc.stdout, "agent-contract: valid\n");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
