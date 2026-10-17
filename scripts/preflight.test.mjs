import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const preflightPath = resolve("scripts/preflight.sh");
const preflight = readFileSync(preflightPath, "utf8");
const dockerTests = [...preflight.match(/docker_only_tests=\(([\s\S]*?)\)/)[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
const bashPath = process.env.PATH.split(":").map((dir) => join(dir, "bash")).find(existsSync);
const dirnamePath = process.env.PATH.split(":").map((dir) => join(dir, "dirname")).find(existsSync);

function runPreflight({ docker = "available", ci = false, githubActions = false, npmStatus = 0, inheritedDockerUnavailable = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ovd909-preflight-"));
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
    const result = spawnSync(bashPath, [preflightPath, "test"], { env, encoding: "utf8", stdio: "pipe" });
    expect(result.error).toBeUndefined();
    expect(result.stderr).toBe("");
    return {
      status: result.status,
      output: result.stdout,
      npmCalls: readFileSync(callsPath, "utf8"),
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
