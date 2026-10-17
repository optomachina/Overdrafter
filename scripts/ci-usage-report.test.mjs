// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  attributeUsage,
  eachDay,
  ghApiArgs,
  JOB_JQ,
  renderUsageMarkdown,
  RUN_JQ,
  runJobsEndpoint,
  sevenDayWindow,
  wallClockMinutes,
  workflowRunsEndpoint,
} from "./ci-usage-report.mjs";

const at = (iso) => iso;

describe("ci usage attribution", () => {
  const runs = [
    {
      id: 1,
      name: "CI",
      path: ".github/workflows/ci.yml",
      pull_requests: [{ number: 10 }],
    },
    {
      id: 2,
      name: "CI",
      path: ".github/workflows/ci.yml",
      pull_requests: [{ number: 10 }, { number: 11 }, { number: 10 }],
    },
    {
      id: 3,
      name: "Ephemeral DB",
      path: ".github/workflows/ephemeral-db.yml",
      pull_requests: [],
    },
  ];
  const jobsByRunId = new Map([
    [1, [
      { started_at: at("2026-10-10T00:00:00Z"), completed_at: at("2026-10-10T00:10:00Z") },
      { started_at: at("2026-10-10T00:00:00Z"), completed_at: at("2026-10-10T00:05:00Z") },
    ]],
    [2, [
      { started_at: at("2026-10-10T01:00:00Z"), completed_at: at("2026-10-10T01:01:30Z") },
    ]],
    [3, [
      { started_at: at("2026-10-10T02:00:00Z"), completed_at: null },
      { started_at: at("2026-10-10T03:00:00Z"), completed_at: at("2026-10-10T02:00:00Z") },
    ]],
  ]);

  it("attributes runs to each listed PR and sums wall-clock minutes", () => {
    const summary = attributeUsage(runs, jobsByRunId);
    expect(summary.pullRequests).toEqual([
      { number: 10, runs: 2, jobs: 3, minutes: 16.5 },
      { number: 11, runs: 1, jobs: 1, minutes: 1.5 },
    ]);
    expect(summary.unattributed).toEqual({ runs: 1, jobs: 2, minutes: 0 });
    // The shared run counts once in the workflow table, not once per PR.
    expect(summary.workflows.find((flow) => flow.name === "CI")).toMatchObject({ runs: 2, jobs: 3, minutes: 16.5 });
    expect(wallClockMinutes("2026-10-10T00:00:00Z", "2026-10-10T00:01:30Z")).toBe(1.5);
    expect(wallClockMinutes("2026-10-10T00:00:00Z", null)).toBe(0);
    expect(wallClockMinutes("2026-10-10T03:00:00Z", "2026-10-10T02:00:00Z")).toBe(0);
  });

  it("renders the per-PR minute table", () => {
    const summary = attributeUsage(runs, jobsByRunId);
    const markdown = renderUsageMarkdown({ repo: "optomachina/Overdrafter", since: "2026-10-10", until: "2026-10-16", ...summary });
    expect(markdown).toContain("| #10 | 2 | 3 | 16.5 |");
    expect(markdown).toContain("| #11 | 1 | 1 | 1.5 |");
    expect(markdown).toContain("| unattributed | 1 | 2 | 0.0 |");
    expect(markdown).toContain("not billable minutes");
    expect(markdown).toContain("unattributed row");
  });

  it("covers seven inclusive UTC days and builds a read-only gh api call", () => {
    expect(sevenDayWindow("2026-10-16")).toEqual({ since: "2026-10-10", until: "2026-10-16" });
    expect(eachDay("2026-10-10", "2026-10-16")).toHaveLength(7);
    const endpoint = workflowRunsEndpoint("optomachina/Overdrafter", "2026-10-10");
    const args = ghApiArgs(endpoint, RUN_JQ);
    expect(args).toEqual(["api", "--paginate", endpoint, "--jq", RUN_JQ]);
    expect(args).not.toContain("--method");
    expect(RUN_JQ.startsWith(".workflow_runs[]")).toBe(true);
    expect(JOB_JQ.startsWith(".jobs[]")).toBe(true);
    expect(runJobsEndpoint("optomachina/Overdrafter", 42)).toBe("repos/optomachina/Overdrafter/actions/runs/42/jobs?per_page=100");
  });
});
