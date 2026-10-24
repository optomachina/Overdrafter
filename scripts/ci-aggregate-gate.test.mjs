// @vitest-environment node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Branch protection requires only the ci aggregate (and provider-go-live), so a
// job blocks a merge only when ci needs it and fails on its result. A matrix
// job blocks only if every leg runs and does real work.
const { jobs } = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const ci = jobs.ci;
const check = ci.steps.find((step) => step.name === "Check dependency results");

// Run the step the way GitHub does (bash -e with pipefail), with every needed
// job succeeding except the overrides.
function runCheck(overrides = {}) {
  const env = { PATH: process.env.PATH };
  for (const [name, value] of Object.entries(check.env)) {
    const job = value.match(/^\$\{\{ needs\.([\w-]+)\.result \}\}$/)?.[1];
    expect(job, `${name} is bound to a needs result`).toBeTruthy();
    env[name] = overrides[job] ?? "success";
  }
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", check.run], { env, encoding: "utf8" });
  expect(result.error).toBeUndefined();
  return result.status;
}

const laneCondition = /matrix\.lane == '([^']+)'/g;
const isTestStep = (step) => /playwright\/cli\.js test |npm run e2e:|scripts\/preflight\.sh test/.test(step.run ?? "");

describe("ci aggregate gate", () => {
  it("needs every job that is not explicitly report-only (continue-on-error)", () => {
    const ungated = Object.entries(jobs)
      .filter(([name, job]) => name !== "ci" && job["continue-on-error"] !== true && !ci.needs.includes(name))
      .map(([name]) => name);
    expect(ungated).toEqual([]);
  });

  it("lets no needed job or step continue on error", () => {
    for (const name of ci.needs) {
      expect(jobs[name]["continue-on-error"], name).toBeUndefined();
      for (const step of jobs[name].steps ?? []) {
        expect(step["continue-on-error"], `${name} > ${step.name}`).toBeUndefined();
      }
    }
  });

  it("binds every needed job's result to the check", () => {
    const bound = Object.values(check.env).map((value) => value.match(/^\$\{\{ needs\.([\w-]+)\.result \}\}$/)?.[1]);
    expect([...bound].sort()).toEqual([...ci.needs].sort());
  });

  it("passes when every needed job succeeded", () => {
    expect(runCheck()).toBe(0);
  });

  it.each(ci.needs.flatMap((job) => ["failure", "cancelled", "skipped"].map((result) => [job, result])))(
    "fails when %s is %s",
    (job, result) => {
      expect(runCheck({ [job]: result })).not.toBe(0);
    },
  );

  it("runs every vitest shard exactly once, unconditionally", () => {
    const { strategy, steps } = jobs.unit;
    expect(strategy["fail-fast"]).toBe(false);
    expect(Object.keys(strategy.matrix)).toEqual(["shard"]);
    const run = steps.find((step) => step.name === "Run tests");
    expect(run.if).toBeUndefined();
    const total = Number(run.run.match(/^bash scripts\/preflight\.sh test -- --shard=\$\{\{ matrix\.shard \}\}\/(\d+)$/)?.[1]);
    expect(total).toBeGreaterThan(1);
    expect(strategy.matrix.shard).toEqual(Array.from({ length: total }, (_, index) => index + 1));
  });

  it("gives every browser lane a test step gated only by its lane", () => {
    const { strategy, steps } = jobs["browser-test"];
    expect(strategy["fail-fast"]).toBe(false);
    expect(Object.keys(strategy.matrix)).toEqual(["lane"]);
    const lanes = strategy.matrix.lane;
    const named = steps.flatMap((step) => [...String(step.if ?? "").matchAll(laneCondition)].map((match) => match[1]));
    expect([...new Set(named)].sort()).toEqual([...lanes].sort());
    const testSteps = steps.filter(isTestStep);
    for (const step of testSteps) {
      expect(lanes.map((lane) => `\${{ matrix.lane == '${lane}' }}`), step.name).toContain(step.if);
    }
    for (const lane of lanes) {
      expect(testSteps.filter((step) => step.if === `\${{ matrix.lane == '${lane}' }}`).length, `test steps in the ${lane} lane`).toBeGreaterThan(0);
    }
  });
});
