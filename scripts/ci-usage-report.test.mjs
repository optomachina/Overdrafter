// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  attributeUsage,
  eachDay,
  forEachLimited,
  ghApiArgs,
  JOB_JQ,
  renderUsageMarkdown,
  RUN_JQ,
  runJobsEndpoint,
  sevenDayWindow,
  wallClockMinutes,
  withRateLimitRetry,
  workflowRunsEndpoint,
} from "./ci-usage-report.mjs";

const script = fileURLToPath(new URL("./ci-usage-report.mjs", import.meta.url));

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
    expect(runJobsEndpoint("optomachina/Overdrafter", 42)).toBe("repos/optomachina/Overdrafter/actions/runs/42/jobs?per_page=100&filter=all");
  });
});

describe("ci usage workflow table order", () => {
  it("sorts workflows by name in code-unit order", () => {
    const runs = ["b", "B", "a", "ab"].map((name, index) => ({ id: index + 1, name, path: `${name}.yml`, pull_requests: [] }));
    const summary = attributeUsage(runs, new Map());
    expect(summary.workflows.map((flow) => flow.name)).toEqual(["B", "a", "ab", "b"]);
  });
});

describe("rate limit retry", () => {
  const rateLimited = () => Object.assign(new Error("gh failed"), { stderr: "gh: API rate limit exceeded (HTTP 403)" });

  it("retries a rate-limited call with a growing pause and returns the first success", async () => {
    const pauses = [];
    let calls = 0;
    const result = await withRateLimitRetry("runs", async () => {
      calls += 1;
      if (calls < 3) throw rateLimited();
      return "ok";
    }, { pause: async (ms) => pauses.push(ms) });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(pauses).toEqual([2000, 4000]);
  });

  it("gives up after five rate-limited attempts and names the label", async () => {
    const pauses = [];
    let calls = 0;
    await expect(
      withRateLimitRetry("jobs 7", async () => {
        calls += 1;
        throw rateLimited();
      }, { pause: async (ms) => pauses.push(ms) }),
    ).rejects.toThrow("jobs 7 failed: gh: API rate limit exceeded (HTTP 403)");
    expect(calls).toBe(5);
    expect(pauses).toEqual([2000, 4000, 6000, 8000]);
  });

  it("does not retry a failure that is not a rate limit", async () => {
    let calls = 0;
    await expect(
      withRateLimitRetry("runs", async () => {
        calls += 1;
        throw new Error("HTTP 404: Not Found");
      }, { pause: async () => { throw new Error("must not pause"); } }),
    ).rejects.toThrow("runs failed: HTTP 404: Not Found");
    expect(calls).toBe(1);
  });
});

describe("bounded sequential fan-out", () => {
  it("with a limit of one runs items one at a time in input order", async () => {
    const order = [];
    let inFlight = 0;
    let peak = 0;
    await forEachLimited(["d1", "d2", "d3"], 1, async (day) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      order.push(day);
      inFlight -= 1;
    });
    expect(order).toEqual(["d1", "d2", "d3"]);
    expect(peak).toBe(1);
  });

  it("runs every item once and never exceeds the limit", async () => {
    const seen = [];
    let inFlight = 0;
    let peak = 0;
    await forEachLimited(Array.from({ length: 10 }, (_, index) => index), 4, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.push(item);
      inFlight -= 1;
    });
    expect([...seen].sort((left, right) => left - right)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(peak).toBe(4);
  });

  it("handles an empty list and rejects when a worker throws", async () => {
    await expect(forEachLimited([], 4, async () => { throw new Error("never"); })).resolves.toBeUndefined();
    await expect(forEachLimited([1, 2], 1, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  });
});

describe("ci usage CLI", () => {
  const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

  it("renders a report from fixture files and rejects an incomplete argument", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-usage-"));
    try {
      const runsFile = join(dir, "runs.json");
      const jobsFile = join(dir, "jobs.json");
      writeFileSync(runsFile, JSON.stringify([{ id: 1, name: "CI", path: ".github/workflows/ci.yml", pull_requests: [{ number: 10 }] }]));
      writeFileSync(jobsFile, JSON.stringify({ 1: [{ started_at: "2026-10-10T00:00:00Z", completed_at: "2026-10-10T00:04:00Z" }] }));
      const ok = run(["--runs-json", runsFile, "--jobs-json", jobsFile, "--since", "2026-10-10", "--until", "2026-10-16"]);
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain("Window: 2026-10-10 through 2026-10-16");
      expect(ok.stdout).toContain("| #10 | 1 | 1 | 4.0 |");

      const incomplete = run(["--since"]);
      expect(incomplete.status).toBe(1);
      expect(incomplete.stderr).toContain("unknown or incomplete argument: --since");
      const unpaired = run(["--runs-json", runsFile]);
      expect(unpaired.status).toBe(1);
      expect(unpaired.stderr).toContain("--runs-json and --jobs-json are a pair");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
