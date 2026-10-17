// @vitest-environment node

import { readFileSync } from "node:fs";
// js-yaml ships with eslint (a dev dependency); no direct dependency added.
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { DEFAULT_REQUIRED_CHECKS } from "./gate.mjs";

const loadWorkflow = (name) => yaml.load(readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8"));
const workflow = loadWorkflow("qa-handoff.yml");
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);

describe("qa-handoff.yml", () => {
  it("has exactly pull-requests: write and contents: read, with no job-level overrides", () => {
    expect(workflow.permissions).toEqual({ "pull-requests": "write", contents: "read" });
    for (const job of Object.values(workflow.jobs)) expect(job.permissions).toBeUndefined();
  });

  it("triggers only on workflow_run completed for the required-check workflows", () => {
    // js-yaml reads the bare `on` key as the string "on".
    expect(Object.keys(workflow.on)).toEqual(["workflow_run"]);
    expect(workflow.on.workflow_run.types).toEqual(["completed"]);
    expect(workflow.on.workflow_run.workflows).toEqual(["CI", "PR body gate"]);
  });

  it("serializes per PR without cancelling in-flight runs", () => {
    expect(workflow.concurrency.group).toBe(
      "qa-handoff-${{ github.event.workflow_run.pull_requests[0].number || github.event.workflow_run.head_branch }}",
    );
    expect(workflow.concurrency["cancel-in-progress"]).toBe(false);
  });

  it("never checks out PR code", () => {
    const checkouts = steps.filter((step) => String(step.uses ?? "").startsWith("actions/checkout"));
    expect(checkouts.length).toBeGreaterThan(0);
    for (const step of checkouts) {
      expect(step.with?.ref).toBe("${{ github.event.repository.default_branch }}");
      const serialized = JSON.stringify(step);
      expect(serialized).not.toMatch(/workflow_run\.head_sha|workflow_run\.head_branch|workflow_run\.head_repository|pull_request|refs\/pull/);
      expect(step.with?.repository).toBeUndefined();
      expect(step.with?.["persist-credentials"]).toBe(false);
    }
  });

  it("runs only for workflow_run events triggered by pull_request", () => {
    for (const job of Object.values(workflow.jobs)) {
      expect(job.if).toBe("github.event.workflow_run.event == 'pull_request'");
    }
  });

  it("never fetches or checks out PR refs in a run step", () => {
    for (const step of steps.filter((item) => item.run)) {
      expect(step.run).not.toContain("gh pr checkout");
      expect(step.run).not.toContain("refs/pull");
      expect(step.run).not.toContain("git fetch");
    }
  });

  it("passes event values through env, not inline into run scripts", () => {
    for (const step of steps.filter((item) => item.run)) {
      expect(step.run).not.toContain("${{");
    }
  });

  it("reads trusted marker authors from the repo variable, through step env only", () => {
    const step = steps.find((item) => item.run?.includes("run.mjs"));
    expect(step.env.QA_HANDOFF_TRUSTED_MARKER_AUTHORS).toBe("${{ vars.QA_HANDOFF_TRUSTED_MARKER_AUTHORS }}");
    expect(step.run).not.toContain("QA_HANDOFF_TRUSTED_MARKER_AUTHORS");
  });

  it("defaults to report mode and documents the required-check fallback", () => {
    const job = workflow.jobs["qa-handoff"];
    expect(job.env.QA_HANDOFF_MODE).toBe("report");
    expect(job.env.REQUIRED_CHECKS.split(",")).toEqual([...DEFAULT_REQUIRED_CHECKS]);
  });
});

describe("pr-body-gate.yml", () => {
  it("re-runs on draft to ready so a workflow_run reaches qa-handoff", () => {
    expect(loadWorkflow("pr-body-gate.yml").on.pull_request.types).toContain("ready_for_review");
  });
});
