/**
 * OVD-876: runs the prod-push scan inside test:portable-node in report mode.
 *
 * The scan runs the base commit's copy of scripts/check-prod-push.mjs (HEAD^1,
 * which is the PR base on a pull_request merge commit), so a change cannot
 * weaken the checker that reviews it. When the base has no checker yet, the
 * head copy runs. Findings go to stdout and $GITHUB_STEP_SUMMARY; this test
 * never fails on them. Blaine's card flips the scan to --enforce.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const GIT_BIN = "/usr/bin/git";
const CHECKER_PATH = "scripts/check-prod-push.mjs";
const BASE_REF = "HEAD^1";
const root = fileURLToPath(new URL("..", import.meta.url));

function git(args) {
  return execFileSync(GIT_BIN, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function hasBaseRef() {
  try {
    git(["rev-parse", "--verify", "--quiet", `${BASE_REF}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** The base commit's checker source, or the head copy when the base has none. */
function checkerSource(baseAvailable) {
  if (baseAvailable) {
    try {
      return { source: git(["show", `${BASE_REF}:${CHECKER_PATH}`]), from: BASE_REF };
    } catch {
      // The base predates the checker.
    }
  }
  return { source: readFileSync(join(root, CHECKER_PATH), "utf8"), from: "HEAD" };
}

test("prod-push scan runs the base copy in report mode", (t) => {
  const baseAvailable = hasBaseRef();
  const { source, from } = checkerSource(baseAvailable);
  const dir = mkdtempSync(join(tmpdir(), "prod-push-scan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const checker = join(dir, "check-prod-push.mjs");
  writeFileSync(checker, source);

  const scope = baseAvailable ? ["--base-ref", BASE_REF] : ["--all"];
  const result = spawnSync(process.execPath, [checker, "--root", root, ...scope, "--report"], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
  });
  process.stdout.write(`prod-push scan: checker from ${from}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  // Report mode exits 0 on findings; only a usage error or a crash lands here.
  assert.equal(result.status, 0, `prod-push scan did not complete: ${result.error?.message ?? result.stderr}`);
});
