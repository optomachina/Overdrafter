/** Portable report-mode run of the secret path block on HEAD^1..HEAD. Never fails on findings. */
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { REPORT_SCHEMA, refExists, run } from "./check-secret-paths.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

function capture() {
  let text = "";
  return { write(chunk) { text += chunk; return true; }, get text() { return text; } };
}

test("secret path block runs in report mode on HEAD^1..HEAD", (t) => {
  if (!refExists(root, "HEAD^1")) {
    t.skip("no HEAD^1 (shallow or single-commit checkout)");
    return;
  }
  const stdout = capture();
  const stderr = capture();
  const code = run(["--json"], { cwd: root, stdout, stderr });
  assert.equal(code, 0, stderr.text);
  const report = JSON.parse(stdout.text);
  assert.equal(report.schema, REPORT_SCHEMA);
  assert.ok(Array.isArray(report.findings));
  assert.ok(Array.isArray(report.gate_loosening));
  if (report.findings.length > 0 || report.gate_loosening.length > 0) {
    t.diagnostic(`secret-paths report mode: ${report.findings.length} blocked, ${report.gate_loosening.length} gate_loosening`);
  }
});
