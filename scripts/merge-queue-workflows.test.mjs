// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Required (and future-required) checks must report on merge_group, or the
// merge queue stalls until it times out. See docs/runbooks/merge-queue.md.
const REQUIRED_CHECKS = [
  { workflow: "ci.yml", job: "ci", noOp: false },
  { workflow: "pr-body-gate.yml", job: "provider-go-live", noOp: true },
];
const FUTURE_REQUIRED_CHECKS = [{ workflow: "proof-check.yml", job: "proof-check", noOp: true }];

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const readWorkflow = (file) => read(`.github/workflows/${file}`);

function onBlock(text) {
  const match = text.match(/^on:\n((?: {2}.*\n|\n)+)/m);
  expect(match, "workflow has an on: block").not.toBeNull();
  return match[1];
}

function jobBlock(text, job) {
  const jobs = text.slice(text.indexOf("\njobs:\n"));
  const start = jobs.search(new RegExp(`^ {2}${job}:\\n`, "m"));
  expect(start, `job ${job}`).toBeGreaterThanOrEqual(0);
  const rest = jobs.slice(start + 1);
  const next = rest.search(/^ {2}[A-Za-z0-9_-]+:\n/m);
  return next === -1 ? rest : rest.slice(0, next);
}

function stepIfs(block) {
  return block.split(/^ {6}- /m).slice(1).map((step) => step.match(/^ {8}if: (.+)$/m)?.[1] ?? null);
}

describe("merge queue workflows", () => {
  for (const check of [...REQUIRED_CHECKS, ...FUTURE_REQUIRED_CHECKS]) {
    describe(`${check.workflow} (${check.job})`, () => {
      const text = readWorkflow(check.workflow);

      it("triggers on merge_group", () => {
        expect(onBlock(text)).toMatch(/^ {2}merge_group:/m);
      });

      it("reports the check under the bare job name", () => {
        expect(jobBlock(text, check.job)).toMatch(new RegExp(`^ {4}name: ${check.job}$`, "m"));
      });

      if (check.noOp) {
        it("has no job-level if that could skip the job", () => {
          expect(jobBlock(text, check.job)).not.toMatch(/^ {4}if:/m);
        });

        it("passes as a no op on merge_group and runs real steps only on pull_request", () => {
          const ifs = stepIfs(jobBlock(text, check.job));
          expect(ifs[0]).toBe("github.event_name == 'merge_group'");
          for (const condition of ifs.slice(1)) {
            expect(condition).toMatch(/github\.event_name == 'pull_request'/);
          }
        });
      } else {
        it("does not skip the aggregate on merge_group", () => {
          const block = jobBlock(text, check.job);
          expect(block).toMatch(/^ {4}if: \$\{\{ always\(\) \}\}$/m);
          expect(text).not.toMatch(/^ {4}if: .*event_name/m);
        });
      }
    });
  }

  describe("vendor PR serialization", () => {
    const text = readWorkflow("vendor-pr-serialization.yml");
    const steps = jobBlock(text, "vendor-pr-serialization").split(/^ {6}- /m).slice(1);
    const queuedCheck = steps.find((step) => step.startsWith("name: Check queued vendor PR\n"));

    it("checks out the merge group's base revision separately without persisted credentials", () => {
      const baseCheckout = steps.find((step) => /^ {10}path: base$/m.test(step));
      expect(baseCheckout).toBeDefined();
      expect(baseCheckout).toMatch(/^uses: actions\/checkout@/);
      expect(baseCheckout).toContain("if: github.event_name == 'merge_group'");
      expect(baseCheckout).toContain("ref: ${{ github.event.merge_group.base_sha }}");
      expect(baseCheckout).toContain("persist-credentials: false");
      expect(baseCheckout).not.toContain("sparse-checkout:");
      expect(steps.indexOf(baseCheckout)).toBeLessThan(steps.indexOf(queuedCheck));
    });

    it("imports and executes the queued check from the base copy", () => {
      expect(queuedCheck).toContain("if: github.event_name == 'merge_group'");
      expect(queuedCheck).toContain("from './base/scripts/vendor-pr-serialization.mjs'");
      expect(queuedCheck).toContain("'base/scripts/vendor-pr-serialization.mjs', '--pr', String(pr)");
      expect(queuedCheck).not.toMatch(/['"](?:\.\/)?scripts\/vendor-pr-serialization\.mjs['"]/);
    });

    it("keeps only read access to contents and pull requests", () => {
      expect(text.match(/^permissions:\n((?: {2}.*\n)+)/m)?.[1]).toBe(
        "  contents: read\n  pull-requests: read\n",
      );
      expect(jobBlock(text, "vendor-pr-serialization")).not.toMatch(/^ {4}permissions:/m);
    });
  });

  it("lists exactly the required checks in the runbook", () => {
    const runbook = read("docs/runbooks/merge-queue.md");
    const names = REQUIRED_CHECKS.map((check) => `\`${check.job}\``).join(", ");
    expect(runbook).toContain(`| Required checks | ${names} (GitHub Actions app). Unchanged. |`);
    expect(runbook).toContain("DO NOT RUN");
    expect(runbook).toContain('"merge_method": "SQUASH"');
    expect(runbook).toContain('"grouping_strategy": "ALLGREEN"');
    expect(runbook).toMatch(/"max_entries_to_build": 1,\n\s+"min_entries_to_merge": 1,\n\s+"max_entries_to_merge": 1/);
  });

  it("drafts the strict fallback with the required checks unchanged", () => {
    const runbook = read("docs/runbooks/merge-queue.md");
    expect(runbook).toContain("--jq .owner.type");
    expect(runbook).toContain(
      "gh api --method PATCH repos/optomachina/Overdrafter/branches/main/protection/required_status_checks",
    );
    const checks = REQUIRED_CHECKS.map((check) => `\\{ "context": "${check.job}", "app_id": 15368 \\}`).join(",\\n\\s+");
    expect(runbook).toMatch(new RegExp(`"strict": true,\\n\\s+"checks": \\[\\n\\s+${checks}\\n\\s+\\]`));
    expect(runbook).not.toMatch(/"enforce_admins"/);
  });
});
