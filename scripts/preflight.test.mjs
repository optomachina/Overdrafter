import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const preflightPath = resolve("scripts/preflight.sh");
const preflight = readFileSync(preflightPath, "utf8");
const dockerTests = [...preflight.match(/docker_only_tests=\(([\s\S]*?)\)/)[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
const bashPath = process.env.PATH.split(":").map((dir) => join(dir, "bash")).find(existsSync);
const dirnamePath = process.env.PATH.split(":").map((dir) => join(dir, "dirname")).find(existsSync);
const nodePath = process.execPath;
const lockfile = (version) => JSON.stringify({ packages: { "": {}, "node_modules/left-pad": { version }, "node_modules/fsevents": { version: "9.9.9", optional: true } } });

function runPreflight({ args = ["test"], docker = "available", ci = false, githubActions = false, npmStatus = 0, inheritedDockerUnavailable = false, stderr = "", workerDeps = "1.0.0" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ovd909-preflight-"));
  // A copy of preflight.sh in a fake repo root, so the worker-deps check reads fixture lockfiles.
  mkdirSync(join(root, "scripts"));
  copyFileSync(preflightPath, join(root, "scripts", "preflight.sh"));
  mkdirSync(join(root, "worker", "node_modules"), { recursive: true });
  writeFileSync(join(root, "worker", "package-lock.json"), lockfile("1.0.0"));
  if (workerDeps !== "missing") writeFileSync(join(root, "worker", "node_modules", ".package-lock.json"), lockfile(workerDeps).replace(/,"node_modules\/fsevents".*?\}/, ""));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const callsPath = join(root, "npm-calls");
  const probePath = join(root, "docker-calls");
  function stub(name, content) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${content}\n`);
    chmodSync(path, 0o755);
  }
  try {
    symlinkSync(bashPath, join(bin, "bash"));
    symlinkSync(dirnamePath, join(bin, "dirname"));
    symlinkSync(nodePath, join(bin, "node"));
    stub("npm", 'printf \'%s\\n\' "$*" "${OVD_PREFLIGHT_DOCKER_UNAVAILABLE-unset}" >> "$NPM_CALLS"\nexit "$NPM_STATUS"');
    if (docker !== "missing") {
      stub("docker", `printf '%s\\n' "$*" >> "$DOCKER_CALLS"\nprintf 'probe output\\n'\nprintf 'probe error\\n' >&2\nexit ${docker === "available" ? 0 : 1}`);
    }
    const env = { ...process.env, PATH: bin, NPM_CALLS: callsPath, NPM_STATUS: String(npmStatus), DOCKER_CALLS: probePath };
    delete env.CI;
    delete env.GITHUB_ACTIONS;
    delete env.OVD_PREFLIGHT_DOCKER_UNAVAILABLE;
    if (inheritedDockerUnavailable) env.OVD_PREFLIGHT_DOCKER_UNAVAILABLE = "1";
    if (ci) env.CI = "true";
    if (githubActions) env.GITHUB_ACTIONS = "true";
    const result = spawnSync(bashPath, [join(root, "scripts", "preflight.sh"), ...args], { env, encoding: "utf8", stdio: "pipe" });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe(stderr);
    return {
      status: result.status,
      output: result.stdout,
      npmCalls: existsSync(callsPath) ? readFileSync(callsPath, "utf8") : "",
      dockerCalls: existsSync(probePath) ? readFileSync(probePath, "utf8") : "",
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function expectSkipped(result, failed = false) {
  expect(result.status).toBe(failed ? 1 : 0);
  expect(result.npmCalls).toBe("run --silent test\n1\n");
  expect(dockerTests).toHaveLength(3);
  expect(result.output.split("\n").filter((line) => line.startsWith("preflight: SKIPPED "))).toEqual(
    dockerTests.map((name) => `preflight: SKIPPED scripts/qualify-ovd417-four-migration-suffix.test.mjs > OVD-417 local qualification harness > ${name} (docker unavailable)`),
  );
  expect(result.output).toBe(
    "preflight: test start\n"
    + dockerTests.map((name) => `preflight: SKIPPED scripts/qualify-ovd417-four-migration-suffix.test.mjs > OVD-417 local qualification harness > ${name} (docker unavailable)\n`).join("")
    + `preflight: test ${failed ? "FAIL" : "PASS"} (3 docker tests SKIPPED: docker unavailable)\n`,
  );
}

describe("preflight local Docker skips", () => {
  it("keeps the skip names identical to the qualification parameterized tests", () => {
    const qualification = readFileSync(resolve("scripts/qualify-ovd417-four-migration-suffix.test.mjs"), "utf8");
    const cases = qualification.match(/\.each\(\[((?:(?!\.each\(\[)[\s\S])*?)\]\)\("(rejects \$name before qualification)"/);
    const names = [...cases[1].matchAll(/name: "([^"]+)"/g)].map((match) => cases[2].replace("$name", () => `'${match[1]}'`));
    expect(dockerTests).toEqual(names);
  });

  it("preserves the original invocation and output with working Docker", () => {
    const result = runPreflight();
    expect(result.status).toBe(0);
    expect(result.npmCalls).toBe("run --silent test\nunset\n");
    expect(result.output).toBe("preflight: test start\npreflight: test PASS\n");
    expect(result.dockerCalls).toBe("info\n");
  });

  it("skips three cases when docker info fails locally", () => {
    const result = runPreflight({ docker: "failing" });
    expectSkipped(result);
    expect(result.dockerCalls).toBe("info\n");
  });

  it("clears an inherited skip flag with working Docker locally", () => {
    const result = runPreflight({ inheritedDockerUnavailable: true });
    expect(result.status).toBe(0);
    expect(result.npmCalls).toBe("run --silent test\nunset\n");
    expect(result.output).toBe("preflight: test start\npreflight: test PASS\n");
    expect(result.dockerCalls).toBe("info\n");
  });

  it("clears an inherited skip flag in CI with Docker missing", () => {
    const result = runPreflight({ docker: "missing", ci: true, inheritedDockerUnavailable: true });
    expect(result.status).toBe(0);
    expect(result.npmCalls).toBe("run --silent test\nunset\n");
    expect(result.output).toBe("preflight: test start\npreflight: test PASS\n");
    expect(result.dockerCalls).toBe("");
  });

  it("skips three cases with Docker entirely absent from the isolated PATH", () => {
    expectSkipped(runPreflight({ docker: "missing" }));
  });

  it.each(["missing", "failing", "available"])("preserves CI behavior with %s Docker without probing", (docker) => {
    const result = runPreflight({ docker, ci: true });
    expect(result.status).toBe(0);
    expect(result.npmCalls).toBe("run --silent test\nunset\n");
    expect(result.output).toBe("preflight: test start\npreflight: test PASS\n");
    expect(result.dockerCalls).toBe("");
  });

  it("never skips under GitHub Actions with CI unset and Docker missing", () => {
    const result = runPreflight({ docker: "missing", githubActions: true, inheritedDockerUnavailable: true });
    expect(result.status).toBe(0);
    expect(result.npmCalls).toBe("run --silent test\nunset\n");
    expect(result.output).toBe("preflight: test start\npreflight: test PASS\n");
    expect(result.dockerCalls).toBe("");
  });

  it("retains failure status and the skipped count when npm fails", () => {
    expectSkipped(runPreflight({ docker: "missing", npmStatus: 1 }), true);
  });
});

describe("preflight stage arguments", () => {
  it("passes arguments after -- to the one stage and names them in the stage lines", () => {
    const result = runPreflight({ args: ["test", "--", "--shard=2/3"], ci: true });
    expect(result.status).toBe(0);
    expect(result.npmCalls).toBe("run --silent test -- --shard=2/3\nunset\n");
    expect(result.output).toBe("preflight: test start (args: --shard=2/3)\npreflight: test PASS (args: --shard=2/3)\n");
  });

  it("prints the FAIL line the rerun classifier reads when a shard fails", () => {
    const result = runPreflight({ args: ["test", "--", "--shard=1/3"], ci: true, npmStatus: 1 });
    expect(result.status).toBe(1);
    expect(result.output).toBe("preflight: test start (args: --shard=1/3)\npreflight: test FAIL (args: --shard=1/3)\n");
    expect(result.output.split("\n")[1]).toMatch(/^preflight: \S+ FAIL\b/);
  });

  it("keeps the local Docker skip when arguments are passed", () => {
    const result = runPreflight({ args: ["test", "--", "--shard=3/3"], docker: "missing" });
    expect(result.status).toBe(0);
    expect(result.npmCalls).toBe("run --silent test -- --shard=3/3\n1\n");
    expect(result.output).toContain("preflight: test PASS (args: --shard=3/3) (3 docker tests SKIPPED: docker unavailable)\n");
  });

  it("treats a bare trailing -- as no arguments", () => {
    const result = runPreflight({ args: ["test", "--"], ci: true });
    expect(result.status).toBe(0);
    expect(result.npmCalls).toBe("run --silent test --\nunset\n");
    expect(result.output).toBe("preflight: test start\npreflight: test PASS\n");
  });

  it("rejects an unknown stage before running any stage", () => {
    const result = runPreflight({ args: ["lint", "bogus"], ci: true, stderr: "preflight: unknown stage 'bogus' (expected lint, typecheck, test)\n" });
    expect(result.status).toBe(2);
    expect(result.npmCalls).toBe("");
    expect(result.output).toBe("");
  });

  it.each([
    [["lint", "test", "--", "--shard=1/3"]],
    [["--", "--shard=1/3"]],
  ])("rejects arguments after -- unless exactly one stage is named: %j", (args) => {
    const result = runPreflight({ args, ci: true, stderr: "preflight: arguments after -- need exactly one stage\n" });
    expect(result.status).toBe(2);
    expect(result.npmCalls).toBe("");
    expect(result.output).toBe("");
  });

  it.each([["missing"], ["stale", "0.9.0"]])("stops before any stage when worker dependencies are %s", (problem, version = "missing") => {
    const result = runPreflight({
      args: ["lint", "test"], ci: true, workerDeps: version,
      stderr: `preflight: worker dependencies ${problem} (worker/node_modules does not match worker/package-lock.json); run: npm --prefix worker ci\n`,
    });
    expect(result.status).toBe(1);
    expect(result.npmCalls).toBe("");
    expect(result.output).toBe("");
  });

  it("does not check worker dependencies for lint or typecheck only", () => {
    const result = runPreflight({ args: ["lint", "typecheck"], ci: true, workerDeps: "missing" });
    expect(result.status).toBe(0);
    expect(result.output).toContain("preflight: typecheck PASS");
  });

  it("ignores an optional package missing from the install", () => {
    const result = runPreflight({ args: ["test"], ci: true });
    expect(result.status).toBe(0);
  });
});
