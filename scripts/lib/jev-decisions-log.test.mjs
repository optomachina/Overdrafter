import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendDecision, validateRow, REASON_CODES } from "./jev-decisions-log.mjs";
import { createMatcher, loadSensitivePaths } from "./sensitive-paths.mjs";

const complete = () => ({ ts: "2026-10-17T16:00:00Z", reason: "jev-score", shadow: false, kind: "pr_risk_screen" });
const hash = (raw) => createHash("sha256").update(raw).digest("hex");
function fixture(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), "jev-decisions-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return join(dir, "log.jsonl");
}
test("T1 complete rows, unknown fields and append-only bytes", (t) => {
  const log = fixture(t), row = { ...complete(), schema: 1, extra: { untouched: [1, "two"] } };
  assert.ok(Object.isFrozen(REASON_CODES));
  assert.deepEqual(REASON_CODES, ["path-rule", "jev-score", "marker-raise", "files-incomplete", "error"]);
  assert.deepEqual(appendDecision(log, row), { ok: true });
  assert.equal(fs.readFileSync(log, "utf8"), JSON.stringify(row) + "\n");
  assert.deepEqual(JSON.parse(fs.readFileSync(log, "utf8")), row);
  assert.equal(fs.existsSync(log + ".rejects.jsonl"), false);
  const prefix = Buffer.from([0xff, 0x00, 0x0a]);
  fs.writeFileSync(log, prefix);
  appendDecision(log, row);
  assert.deepEqual(fs.readFileSync(log), Buffer.concat([prefix, Buffer.from(JSON.stringify(row) + "\n")]));
});
test("T2 each missing field rejects with hash-only evidence", (t) => {
  for (const field of ["ts", "reason", "shadow", "kind"]) {
    const log = fixture(t), row = complete(), warnings = [];
    delete row[field];
    fs.writeFileSync(log, "existing\n");
    assert.deepEqual(appendDecision(log, row, { warn: (m) => warnings.push(m) }), { ok: false, problems: [`missing: ${field}`] });
    assert.equal(fs.readFileSync(log, "utf8"), "existing\n");
    const lines = fs.readFileSync(log + ".rejects.jsonl", "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const rejected = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(rejected).sort(), ["log", "problems", "row_sha256", "ts"]);
    assert.deepEqual(rejected.problems, [`missing: ${field}`]);
    assert.equal(rejected.log, log);
    assert.ok(Number.isFinite(Date.parse(rejected.ts)));
    assert.equal(rejected.row_sha256, hash(JSON.stringify(row)));
    assert.deepEqual(warnings, [`jev-decisions: rejected row (missing: ${field})`]);
  }
});
test("T3 bad values, utc alias and non-objects", () => {
  for (const [field, values] of Object.entries({ ts: ["2026-10-17T16:00:00", "yesterday"], reason: ["", "  ", null, "ok", "jev score"], shadow: ["false", 0, 1, null], kind: ["", null] })) {
    for (const value of values) {
      const result = validateRow({ ...complete(), [field]: value });
      assert.equal(result.ok, false);
      assert.ok(result.problems.some((p) => p.startsWith(field + ":")));
    }
  }
  const row = complete(); row.utc = row.ts; delete row.ts;
  assert.deepEqual(validateRow(row), { ok: false, problems: ["missing: ts"] });
  for (const value of [null, [], "row", 1, new Date()]) assert.equal(validateRow(value).ok, false);
  assert.equal(validateRow({ ...complete(), ts: "2026-10-17T09:00:00-07:00" }).ok, true);
});
test("T4 shadow routing both ways", (t) => {
  for (const shadow of [true, false]) {
    const log = fixture(t) + (shadow ? "" : ".shadow.jsonl");
    fs.writeFileSync(log, "preserved");
    assert.equal(appendDecision(log, { ...complete(), shadow }, { warn() {} }).ok, false);
    assert.equal(fs.readFileSync(log, "utf8"), "preserved");
  }
  assert.equal(appendDecision(fixture(t) + ".shadow.jsonl", { ...complete(), shadow: true }).ok, true);
});
test("T5 CLI exit codes and invalid JSON evidence", (t) => {
  const log = fixture(t), cli = fileURLToPath(new URL("./jev-decisions-log.mjs", import.meta.url));
  for (const [input, status] of [[JSON.stringify(complete()), 0], ["{}", 3], ["not json", 3]]) {
    fs.writeFileSync(log + ".stdin", input);
    const fd = fs.openSync(log + ".stdin", "r");
    const err = fs.openSync(log + ".stderr", "w");
    const result = spawnSync(process.execPath, [cli, "--append", log], { stdio: [fd, "ignore", err], timeout: 5000 });
    fs.closeSync(fd); fs.closeSync(err);
    result.stderr = fs.readFileSync(log + ".stderr", "utf8");
    assert.equal(result.status, status);
    assert.equal(result.stderr.split("\n").filter(Boolean).length, status ? 1 : 0);
  }
  const rejects = fs.readFileSync(log + ".rejects.jsonl", "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(rejects[1].problems, ["invalid json"]);
  assert.equal(rejects[1].row_sha256, hash("not json"));
  const err = fs.openSync(log + ".stderr", "w");
  const usage = spawnSync(process.execPath, [cli, "--append"], { stdio: ["ignore", "ignore", err], timeout: 5000 });
  fs.closeSync(err);
  usage.stderr = fs.readFileSync(log + ".stderr", "utf8");
  assert.equal(usage.status, 2);
  assert.equal(usage.stderr, "usage: jev-decisions-log.mjs --append <log>\n");
});
test("T6 secrets never reach logs, rejects or warnings", (t) => {
  const previous = process.env.TYPESAFE_API_KEY, key = "synthetic-test-key-955";
  process.env.TYPESAFE_API_KEY = ` ${key} `;
  t.after(() => { if (previous === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previous; });
  for (const field of ["reason", "extra"]) {
    const log = fixture(t), warnings = [];
    const result = appendDecision(log, { ...complete(), [field]: key }, { warn: (m) => warnings.push(m) });
    assert.equal(result.ok, false);
    assert.ok(result.problems.includes("secret: row contains api key"));
    assert.equal(fs.existsSync(log), false);
    assert.equal(fs.readFileSync(log + ".rejects.jsonl", "utf8").includes(key), false);
    assert.equal(warnings.join("\n").includes(key), false);
  }
});
test("writer is classified infra_ci", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  assert.deepEqual(createMatcher(loadSensitivePaths({ root })).classify("scripts/lib/jev-decisions-log.mjs"), ["infra_ci"]);
});
