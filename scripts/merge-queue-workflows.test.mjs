// @vitest-environment node

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { commentFilterExpression } from "./ovd-merge-gate.mjs";

// Required (and future-required) checks must report on merge_group, or the
// merge queue stalls until it times out. See docs/runbooks/merge-queue.md.
const REQUIRED_CHECKS = [
  { workflow: "ci.yml", job: "ci", noOp: false },
  { workflow: "pr-body-gate.yml", job: "provider-go-live", noOp: true },
  // Scans base..head for real on the queue commit: never a no op, so the queue
  // cannot pass a range the pull_request run would not have scanned.
  { workflow: "secret-scan.yml", job: "secret-scan", range: true },
];
// A writer check is not a job's own status: the job (named differently on
// purpose) writes the check run through the Checks API, also on merge_group.
const FUTURE_REQUIRED_CHECKS = [
  { workflow: "proof-check.yml", job: "proof-check", noOp: true },
  { workflow: "ovd-merge-gate.yml", job: "ovd-merge-gate", writer: "ovd-merge-gate-writer" },
];

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

      it("triggers on merge_group checks_requested and has no paths filter", () => {
        expect(onBlock(text)).toMatch(/^ {2}merge_group:\n {4}types:\n {6}- checks_requested\n/m);
        expect(onBlock(text)).not.toMatch(/^ {4}paths(?:-ignore)?:/m);
      });

      if (check.writer) {
        it("writes the check from a job with another name and no job-level if", () => {
          const block = jobBlock(text, check.writer);
          expect(block).toMatch(new RegExp(`^ {4}name: ${check.writer}$`, "m"));
          // The only job-level if allowed is always() (OVD-959 F1: run even when a needed job failed),
          // narrowed only for issue_comment to comments with a verdict marker or approval fence (OVD-1144).
          for (const line of block.match(/^ {4}if:.*$/gm) ?? []) {
            expect(line).toBe(
              `    if: "\${{ always() && github.event_name != 'merge_group' && ${commentFilterExpression()} }}"`,
            );
          }
          expect(text).not.toMatch(new RegExp(`^ {2}${check.job}:\\n`, "m"));
          expect(text).not.toMatch(new RegExp(`^ {4}name: ${check.job}$`, "m"));
        });

        it("writes the check on merge_group as a no op", () => {
          const queue = jobBlock(text, "ovd-merge-gate-queue");
          expect(queue).toContain("if: github.event_name == 'merge_group'");
          expect(queue).toContain("gh api --method POST");
          expect(queue).toContain("-f name=ovd-merge-gate");
          expect(queue).not.toContain("checkout");
        });
        return;
      }

      it("reports the check under the bare job name", () => {
        expect(jobBlock(text, check.job)).toMatch(new RegExp(`^ {4}name: ${check.job}$`, "m"));
      });

      if (check.range) {
        it("has no job-level if and no step gated on the event", () => {
          const block = jobBlock(text, check.job);
          expect(block).not.toMatch(/^ {4}if:/m);
          for (const condition of stepIfs(block)) {
            expect(condition ?? "").not.toMatch(/event_name|pull_request|merge_group/);
          }
        });

        it("diffs the merge group's base and head on merge_group", () => {
          const block = jobBlock(text, check.job);
          expect(block).toContain(
            "BASE_SHA: ${{ github.event_name == 'merge_group' && github.event.merge_group.base_sha || github.event.pull_request.base.sha }}",
          );
          expect(block).toContain(
            "HEAD_SHA: ${{ github.event_name == 'merge_group' && github.event.merge_group.head_sha || github.event.pull_request.head.sha }}",
          );
          // github.sha is the queue commit on merge_group, unique per queue entry.
          expect(text).toMatch(/^ {2}group: [^\n]*\|\| github\.sha \}\}$/m);
        });
      } else if (check.noOp) {
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

    it("re-checks all open PRs on schedule/push in report-only mode but keeps pull_request blocking", () => {
      const recheck = steps.find((step) => step.startsWith("name: Re-check all open vendor PRs\n"));
      const prCheck = steps.find((step) => step.startsWith("name: Check open vendor PRs\n"));
      expect(recheck).toContain("if: github.event_name == 'schedule' || github.event_name == 'push'");
      expect(recheck).toContain("node scripts/vendor-pr-serialization.mjs --all --report-only");
      expect(recheck).not.toContain("continue-on-error");
      expect(prCheck).toContain("if: github.event_name == 'pull_request'");
      expect(prCheck).not.toContain("--report-only");
      expect(queuedCheck).not.toContain("--report-only");
    });

    it("keeps only read access to contents and pull requests", () => {
      expect(text.match(/^permissions:\n((?: {2}.*\n)+)/m)?.[1]).toBe(
        "  contents: read\n  pull-requests: read\n",
      );
      expect(jobBlock(text, "vendor-pr-serialization")).not.toMatch(/^ {4}permissions:/m);
    });
  });

  // OVD-1145: required checks are cancelled only by a newer run for the same head
  // sha, never by an unrelated event on the PR.
  describe("required check concurrency (OVD-1145)", () => {
    const HEAD_SHA_GROUP =
      "  group: ${{ github.workflow }}-${{ github.event.pull_request.head.sha || github.sha }}\n  cancel-in-progress: true\n";
    for (const workflow of [...new Set([...REQUIRED_CHECKS.map((check) => check.workflow), "verify.yml"])]) {
      it(`${workflow} groups runs by head sha`, () => {
        const text = readWorkflow(workflow);
        const block = text.match(/^concurrency:\n((?: {2}.*\n)+)/m)?.[1] ?? "";
        expect(block.replace(/^ {2}#.*\n/gm, "")).toBe(HEAD_SHA_GROUP);
        expect(text.match(/^concurrency:/gm)).toHaveLength(1);
      });
    }

    it("pr-body-gate.yml does not trigger on edited", () => {
      expect(onBlock(readWorkflow("pr-body-gate.yml"))).not.toMatch(/^ {6}- edited$/m);
    });
  });

  describe("required checks rerun (OVD-1145)", () => {
    const text = readWorkflow("required-checks-rerun.yml");

    it("runs nightly and on demand only", () => {
      expect(onBlock(text)).toBe('  schedule:\n    - cron: "41 9 * * *"\n  workflow_dispatch:\n\n');
    });

    it("keeps least-privilege permissions and no job-level override", () => {
      expect(text.match(/^permissions:\n((?: {2}.*\n)+)/m)?.[1]).toBe(
        "  actions: write\n  checks: read\n  pull-requests: read\n",
      );
      expect(text).not.toMatch(/^ {4}permissions:/m);
      expect(text).not.toContain("actions/checkout");
    });

    it("re-runs over REST and never writes to a PR", () => {
      expect(text).toContain('actions/runs/$run_id/$endpoint');
      expect(text).toContain('endpoint="rerun"');
      expect(text).toContain('endpoint="rerun-failed-jobs"');
      expect(text).not.toMatch(/\/comments|\/labels|\/reviews|gh pr |--method (?:PATCH|PUT|DELETE)/);
      expect(text.match(/--method POST/g)).toHaveLength(1);
    });

    it("falls back to main for the default branch and fails closed when it is empty", () => {
      // schedule event payloads have no repository object, so the expression alone would be "".
      expect(text).toContain("DEFAULT_BRANCH: ${{ github.event.repository.default_branch || 'main' }}");
      expect(text).toMatch(/\[ -n "\$\{DEFAULT_BRANCH:-\}" \] \|\| \{ echo "::error::[^"]*"; exit 1; \}/);
    });

    it("covers exactly the required checks and their workflows", () => {
      const pairs = REQUIRED_CHECKS.map((check) => `${check.job}=${check.workflow}`).join(" ");
      expect(text).toContain(`REQUIRED_CHECKS: "${pairs}"`);
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
