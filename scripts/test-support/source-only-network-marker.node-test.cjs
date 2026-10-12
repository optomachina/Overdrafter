"use strict";

// Pure local-filesystem tests for run-wide failure propagation. These do not
// invoke fetch, HTTP, sockets, DNS, or any external-looking network target.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { test } = require("node:test");
const guardPath = path.resolve(__dirname, "source-only-network.cjs");

function isolatedOwner(source) {
  return spawnSync(process.execPath, ["-e", source], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, NODE_OPTIONS: `--require=${guardPath}`, OVD_SOURCE_ONLY_NETWORK_MARKER: "" },
  });
}

test("an untouched marker preserves a successful local process", () => {
  const result = isolatedOwner("process[Symbol.for('overdrafter.source-only-network')].assertNoUnexpectedNetwork();");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test("an ignored child exit cannot hide its appended failure marker", () => {
  const result = isolatedOwner(`
    const { spawnSync } = require('node:child_process');
    spawnSync(process.execPath, ['-e', "require('node:fs').appendFileSync(process.env.OVD_SOURCE_ONLY_NETWORK_MARKER, 'blocked' + String.fromCharCode(10));"], { encoding: 'utf8' });
    // Deliberately ignore the child's exit status; the owner must still fail.
  `);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /1 unexpected outbound attempt.*blocked across this run/);
});

test("an ignored Worker exit cannot hide its appended failure marker", () => {
  const result = isolatedOwner(`
    const { Worker } = require('node:worker_threads');
    const worker = new Worker("require('node:fs').appendFileSync(process.env.OVD_SOURCE_ONLY_NETWORK_MARKER, 'blocked' + String.fromCharCode(10));", { eval: true });
    worker.on('error', () => {});
    worker.on('exit', () => {});
  `);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /1 unexpected outbound attempt.*blocked across this run/);
});
