// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codeFence, main, stepSummary, writeStepSummary } from "./run.mjs";

// Independent of codeFence: the longest run of backticks, by a plain scan.
function longestRun(text) {
  return text.split(/[^`]+/).reduce((max, run) => Math.max(max, run.length), 0);
}

function runCount(text) {
  return text.split(/[^`]+/).filter(Boolean).length;
}

// CommonMark: line endings are LF, CR or CRLF. A closing fence is a line of
// backticks, at least as long as the opener, with at most 3 spaces of indent
// and only spaces or tabs after it. Returns every row that would close the
// block, so the only one allowed is the final fence.
function fenceRows(summary) {
  const rows = summary.split(/\r\n|\r|\n/);
  const open = rows.findIndex((row) => /^`{3,}$/.test(row));
  const fence = rows[open];
  const closers = [];
  rows.forEach((row, i) => {
    const match = i > open ? /^ {0,3}(`+)[ \t]*$/.exec(row) : null;
    if (match && match[1].length >= fence.length) closers.push(i);
  });
  return { fence, closers, last: rows.lastIndexOf(fence) };
}

function expectSingleFence(summary, body) {
  const { fence, closers, last } = fenceRows(summary);
  expect(fence.length).toBeGreaterThanOrEqual(3);
  expect(fence.length).toBeGreaterThan(longestRun(body));
  // The only closing fence is the final one.
  expect(closers).toEqual([last]);
  expect(summary.endsWith(`\n${fence}\n`)).toBe(true);
}

describe("codeFence", () => {
  it("uses three backticks for plain content", () => {
    expect(codeFence("feature/plain")).toBe("```");
    expect(codeFence("")).toBe("```");
  });

  it.each([
    ["single backtick", "a`b", "```"],
    ["triple backticks", "a```b", "````"],
    ["longer run", "x`````y ``", "``````"],
    ["tildes only", "a~~~b", "```"],
    ["a run at the very end", "ab````", "`````"],
  ])("handles %s", (_name, content, expected) => {
    expect(codeFence(content)).toBe(expected);
  });

  it("handles 200k separate backtick runs without overflowing the stack", () => {
    const content = "`a".repeat(200_000);
    expect(runCount(content)).toBe(200_000);
    expect(codeFence(content)).toBe("```");
  });

  it("is longer than a backtick run that dwarfs the default fence among 200k small ones", () => {
    const content = `${"`a".repeat(200_000)}${"`".repeat(150_000)}b${"``a".repeat(10)}`;
    expect(codeFence(content)).toBe("`".repeat(150_001));
  });

  it("accepts non-string content", () => {
    expect(codeFence(undefined)).toBe("```");
    expect(codeFence(12345)).toBe("```");
  });
});

describe("stepSummary", () => {
  it.each([
    ["single backtick", "branch: feat/`x`"],
    ["triple backticks", "branch: feat/```\n# injected"],
    ["tildes", "branch: feat/~~~\n# injected"],
    ["mixed", "branch: `a` ``` ~~~ ````` end"],
    ["a line of only three backticks", "```"],
    ["an indented line of only backticks", "   ````"],
    ["a line of backticks with trailing space", "````` "],
    ["a bare CR before backticks", "x\r```"],
    ["CRLF before backticks", "x\r\n````\r\n# injected"],
  ])("content with %s cannot close the fence", (_name, line) => {
    const lines = ["first", line, "last"];
    const summary = stepSummary("report", lines);
    expectSingleFence(summary, lines.join("\n"));
    expect(summary).toContain(line);
  });

  it("fences a body of 200k backtick runs", () => {
    const lines = Array.from({ length: 2_000 }, (_, i) => `#${i} ${"`a".repeat(100)}`);
    lines.push("`".repeat(130));
    const body = lines.join("\n");
    expect(runCount(body)).toBeGreaterThan(200_000);
    const summary = stepSummary("report", lines);
    expectSingleFence(summary, body);
    expect(summary.startsWith("### QA handoff (report mode)\n\n")).toBe(true);
    expect(fenceRows(summary).fence).toBe("`".repeat(131));
  });
});

describe("writeStepSummary", () => {
  const lines = ["a", "b"];

  it("writes the full summary when building succeeds", () => {
    const writes = [];
    const kind = writeStepSummary({ path: "p", mode: "report", lines, append: (path, text) => writes.push([path, text]) });
    expect(kind).toBe("full");
    expect(writes).toEqual([["p", stepSummary("report", lines)]]);
  });

  it("writes a short fallback summary when building throws", () => {
    const writes = [];
    const warnings = [];
    const kind = writeStepSummary({
      path: "p",
      mode: "report",
      lines,
      build: () => {
        throw new RangeError("Maximum call stack size exceeded");
      },
      append: (path, text) => writes.push([path, text]),
      warn: (message) => warnings.push(message),
    });
    expect(kind).toBe("fallback");
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toMatch(/^### QA handoff \(report mode\)\n\n.+\n$/);
    expect(writes[0][1].length).toBeLessThan(300);
    expect(warnings).toEqual(["qa-handoff: could not write full step summary: Maximum call stack size exceeded"]);
  });

  it("falls back when the full summary cannot be written, and never throws if nothing can", () => {
    const attempts = [];
    const boom = (path, text) => {
      attempts.push(text);
      throw new Error("ENOSPC");
    };
    const warnings = [];
    expect(writeStepSummary({ path: "p", mode: "apply", lines, append: boom, warn: (m) => warnings.push(m) })).toBe("failed");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toBe(stepSummary("apply", lines));
    expect(attempts[1]).toContain("### QA handoff (apply mode)");
    expect(warnings).toHaveLength(2);

    let first = true;
    const flaky = (_path, text) => {
      if (first) {
        first = false;
        throw new Error("EIO");
      }
      attempts.push(text);
    };
    expect(writeStepSummary({ path: "p", mode: "report", lines, append: flaky, warn: () => {} })).toBe("fallback");
  });
});

describe("main step summary", () => {
  const SHA = "a".repeat(40);
  let dir;
  let summaryPath;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qa-handoff-summary-"));
    summaryPath = join(dir, "summary.md");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Every open PR targets a non-main base whose name is full of backtick runs,
  // so each PR adds a log line with ~90 of them. This is the shape that
  // overflowed the stack in codeFence at roughly 120k runs.
  function fakeApi({ count, baseRef }) {
    const open = Array.from({ length: count }, (_, i) => ({ number: i + 1, head: { sha: SHA } }));
    return {
      getBranchRequiredChecks: async () => ["ci"],
      getProtectionRequiredChecks: async () => ["ci"],
      listOpenPrs: async () => open,
      getPr: async (number) => ({ number, state: "open", draft: false, base: { ref: baseRef }, head: { sha: SHA } }),
      listCheckRuns: async () => [],
      listStatuses: async () => [],
      listComments: async () => [],
    };
  }

  async function runMain({ api, buildSummary, env = {}, mode = "report" }) {
    const exits = [];
    const errors = [];
    const printed = [];
    await main({
      argv: ["--repo", "o/r", "--mode", mode],
      env: { GITHUB_TOKEN: "test-token", GITHUB_STEP_SUMMARY: summaryPath, ...env },
      api,
      buildSummary,
      exit: (code) => exits.push(code),
      out: (line) => printed.push(line),
      err: (line) => errors.push(line),
    });
    return { exits, errors, printed };
  }

  it("keeps the full summary and exits 0 when the log holds 200k backtick runs", async () => {
    const { exits, errors, printed } = await runMain({ api: fakeApi({ count: 2_500, baseRef: "`a".repeat(100) }) });
    // The fixture must stay above the old overflow threshold.
    expect(runCount(printed.join("\n"))).toBeGreaterThan(200_000);
    expect(exits).toEqual([0]);
    expect(errors).toEqual([]);
    const summary = readFileSync(summaryPath, "utf8");
    expectSingleFence(summary, printed.join("\n"));
    expect(summary).toContain("#2500 ");
  });

  it("writes a fallback summary and still exits 0 when building the summary throws", async () => {
    const { exits, errors } = await runMain({
      api: fakeApi({ count: 1, baseRef: "main" }),
      buildSummary: () => {
        throw new RangeError("injected");
      },
    });
    expect(exits).toEqual([0]);
    expect(errors).toEqual(["qa-handoff: could not write full step summary: injected"]);
    const summary = readFileSync(summaryPath, "utf8");
    expect(summary).toMatch(/^### QA handoff \(report mode\)\n\n.+\n$/);
    expect(summary).not.toContain("#1 ");
  });

  it("exits 0 with a warning when the summary file cannot be written", async () => {
    const { exits, errors } = await runMain({
      api: fakeApi({ count: 1, baseRef: "main" }),
      env: { GITHUB_STEP_SUMMARY: join(dir, "missing", "summary.md") },
    });
    expect(exits).toEqual([0]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("could not write full step summary");
    expect(errors[1]).toContain("could not write fallback step summary");
  });

  it("does not let the summary change the exit status of a failed run", async () => {
    const api = { ...fakeApi({ count: 1, baseRef: "main" }), listOpenPrs: async () => Promise.reject(new Error("API down")) };
    const { exits } = await runMain({ api });
    expect(exits).toEqual([1]);
    expect(readFileSync(summaryPath, "utf8")).toContain("ERROR: API down");
  });

  it("writes no summary when GITHUB_STEP_SUMMARY is unset", async () => {
    const { exits, errors } = await runMain({ api: fakeApi({ count: 1, baseRef: "main" }), env: { GITHUB_STEP_SUMMARY: "" } });
    expect(exits).toEqual([0]);
    expect(errors).toEqual([]);
  });
});
