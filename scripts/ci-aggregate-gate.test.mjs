// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Branch protection requires only the ci aggregate (and provider-go-live), so a
// job blocks a merge only when ci needs it and fails on its result. A matrix
// job blocks only if every leg runs and does real work.
const { jobs } = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const ci = jobs.ci;
const check = ci.steps.find((step) => step.name === "Check dependency results");

// extraction-gate legitimately skips without a corpus or provider key, so ci
// fails only on its failure (see the comment beside that check in ci.yml).
const FAILURE_ONLY = new Set(["extraction-gate"]);

const laneCondition = /matrix\.lane == '([^']+)'/g;

describe("ci aggregate gate", () => {
  it("needs every job that is not explicitly report-only (continue-on-error)", () => {
    const ungated = Object.entries(jobs)
      .filter(([name, job]) => name !== "ci" && job["continue-on-error"] !== true && !ci.needs.includes(name))
      .map(([name]) => name);
    expect(ungated).toEqual([]);
  });

  it.each(ci.needs)("fails unless %s succeeded", (job) => {
    const variable = Object.entries(check.env).find(([, value]) => value === `\${{ needs.${job}.result }}`)?.[0];
    expect(variable, `an env var bound to needs.${job}.result`).toBeTruthy();
    const condition = FAILURE_ONLY.has(job) ? `[ "$${variable}" = "failure" ]` : `[ "$${variable}" != "success" ]`;
    expect(check.run).toContain(condition);
  });

  it("runs every vitest shard exactly once and keeps failed shards from cancelling the rest", () => {
    const { strategy, steps } = jobs.unit;
    expect(strategy["fail-fast"]).toBe(false);
    expect(Object.keys(strategy.matrix)).toEqual(["shard"]);
    const run = steps.find((step) => step.name === "Run tests").run;
    const total = Number(run.match(/^bash scripts\/preflight\.sh test -- --shard=\$\{\{ matrix\.shard \}\}\/(\d+)$/)?.[1]);
    expect(total).toBeGreaterThan(1);
    expect(strategy.matrix.shard).toEqual(Array.from({ length: total }, (_, index) => index + 1));
  });

  it("gives every browser lane a test step and names no undeclared lane", () => {
    const { strategy, steps } = jobs["browser-test"];
    expect(strategy["fail-fast"]).toBe(false);
    expect(Object.keys(strategy.matrix)).toEqual(["lane"]);
    const lanes = strategy.matrix.lane;
    const named = steps.flatMap((step) => [...String(step.if ?? "").matchAll(laneCondition)].map((match) => match[1]));
    expect([...new Set(named)].sort()).toEqual([...lanes].sort());
    for (const lane of lanes) {
      const tests = steps.filter((step) => String(step.if ?? "").includes(`matrix.lane == '${lane}'`)
        && /playwright\/cli\.js test |npm run e2e:/.test(step.run ?? ""));
      expect(tests.length, `test steps in the ${lane} lane`).toBeGreaterThan(0);
    }
  });
});
