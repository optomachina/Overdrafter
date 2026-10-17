// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codeFence, describeError, main, stepSummary, writeStepSummary } from "./run.mjs";

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

// A proxy whose every trap throws: reading any property, its prototype or its
// keys fails, as does anything that stringifies it.
function throwingProxy() {
  const trap = new Proxy({}, { get: () => () => { throw new Error("trap"); } });
  return new Proxy({}, trap);
}

// Thrown values whose message cannot be read or printed. Each is a function so
// every test gets a fresh value.
const HOSTILE_THROWABLES = [
  ["an object whose message getter throws", () => ({ get message() { throw new Error("diagnostic failed"); } })],
  ["a Symbol", () => Symbol("boom")],
  ["a Proxy that throws on every access", throwingProxy],
  ["an object whose message has no prototype", () => ({ message: Object.create(null) })],
  ["null", () => null],
  ["undefined", () => undefined],
];

describe("describeError", () => {
  it("reads an Error message and strips control characters", () => {
    expect(describeError(new Error("a\nb\u0007c"))).toBe("a b c");
  });

  it("reads a thrown string and caps long text", () => {
    expect(describeError("boom")).toBe("boom");
    expect(describeError(new Error("x".repeat(600)), 500)).toHaveLength(500);
    expect(describeError(new Error("x".repeat(600)))).toHaveLength(200);
  });

  it.each(HOSTILE_THROWABLES)("falls back to a constant for %s", (_name, make) => {
    expect(describeError(make())).toBe("unprintable error");
    expect(describeError(make(), 500)).toBe("unprintable error");
  });
});

describe("writeStepSummary", () => {
  const lines = ["a", "b"];

  // On a regression, report "threw" rather than the thrown value: a hostile
  // value can crash the test reporter that tries to print it.
  const write = (options) => {
    try {
      return writeStepSummary(options);
    } catch {
      throw new Error("writeStepSummary threw");
    }
  };

  it("writes the full summary when building succeeds", () => {
    const writes = [];
    const kind = write({ path: "p", mode: "report", lines, append: (path, text) => writes.push([path, text]) });
    expect(kind).toBe("full");
    expect(writes).toEqual([["p", stepSummary("report", lines)]]);
  });

  it("writes a short fallback summary when building throws", () => {
    const writes = [];
    const warnings = [];
    const kind = write({
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
    expect(write({ path: "p", mode: "apply", lines, append: boom, warn: (m) => warnings.push(m) })).toBe("failed");
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
    expect(write({ path: "p", mode: "report", lines, append: flaky, warn: () => {} })).toBe("fallback");
  });

  it.each(HOSTILE_THROWABLES)("falls back and warns with a constant when building throws %s", (_name, make) => {
    const writes = [];
    const warnings = [];
    const kind = write({
      path: "p",
      mode: "report",
      lines,
      build: () => {
        throw make();
      },
      append: (path, text) => writes.push([path, text]),
      warn: (message) => warnings.push(message),
    });
    expect(kind).toBe("fallback");
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toMatch(/^### QA handoff \(report mode\)\n\n.+\n$/);
    expect(warnings).toEqual(["qa-handoff: could not write full step summary: unprintable error"]);
  });

  it.each(HOSTILE_THROWABLES)("reports failed and warns twice when writing throws %s", (_name, make) => {
    const warnings = [];
    const kind = write({
      path: "p",
      mode: "apply",
      lines,
      append: () => {
        throw make();
      },
      warn: (message) => warnings.push(message),
    });
    expect(kind).toBe("failed");
    expect(warnings).toEqual([
      "qa-handoff: could not write full step summary: unprintable error",
      "qa-handoff: could not write fallback step summary: unprintable error",
    ]);
  });

  it("still writes the fallback when the warning sink throws", () => {
    const writes = [];
    let warned = 0;
    const kind = write({
      path: "p",
      mode: "report",
      lines,
      build: () => {
        throw new RangeError("injected");
      },
      append: (path, text) => writes.push([path, text]),
      warn: () => {
        warned += 1;
        throw new Error("stderr is closed");
      },
    });
    expect(kind).toBe("fallback");
    expect(warned).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toContain("### QA handoff (report mode)");
  });

  it("returns failed without throwing when the writer and the warning sink both throw", () => {
    let attempts = 0;
    const kind = write({
      path: "p",
      mode: "report",
      lines,
      append: () => {
        attempts += 1;
        throw { get message() { throw new Error("diagnostic failed"); } };
      },
      warn: () => {
        throw throwingProxy();
      },
    });
    expect(kind).toBe("failed");
    expect(attempts).toBe(2);
  });

  it("does not throw when the warning sink is not a function", () => {
    const append = () => {
      throw new Error("ENOSPC");
    };
    expect(write({ path: "p", mode: "report", lines, append, warn: null })).toBe("failed");
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

  async function runMain({ api, buildSummary, env = {}, mode = "report", argv, out, err }) {
    const exits = [];
    const errors = [];
    const printed = [];
    try {
      await main({
        argv: argv ?? ["--repo", "o/r", "--mode", mode],
        env: { GITHUB_TOKEN: "test-token", GITHUB_STEP_SUMMARY: summaryPath, ...env },
        api,
        buildSummary,
        exit: (code) => exits.push(code),
        out: out ?? ((line) => printed.push(line)),
        err: err ?? ((line) => errors.push(line)),
      });
    } catch {
      // Report "rejected" rather than the rejection: a hostile value can crash the test reporter.
      throw new Error("main() rejected");
    }
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

  describe.each(["report", "apply"])("in %s mode", (mode) => {
    it.each(HOSTILE_THROWABLES)("writes the fallback summary and exits 0 when building throws %s", async (_name, make) => {
      const { exits, errors } = await runMain({
        mode,
        api: fakeApi({ count: 1, baseRef: "main" }),
        buildSummary: () => {
          throw make();
        },
      });
      expect(exits).toEqual([0]);
      expect(errors).toEqual(["qa-handoff: could not write full step summary: unprintable error"]);
      expect(readFileSync(summaryPath, "utf8")).toBe(
        `### QA handoff (${mode} mode)\n\nThe detailed job summary could not be rendered; see this step's log for the full output.\n`,
      );
    });

    it.each(HOSTILE_THROWABLES)("logs a constant error line and exits 1 when the run throws %s", async (_name, make) => {
      const api = {
        ...fakeApi({ count: 1, baseRef: "main" }),
        listOpenPrs: async () => {
          throw make();
        },
      };
      const { exits, errors, printed } = await runMain({ mode, api });
      expect(exits).toEqual([1]);
      expect(errors).toEqual([]);
      expect(printed).toContain("ERROR: unprintable error");
      expect(readFileSync(summaryPath, "utf8")).toContain("ERROR: unprintable error");
    });

    it("writes the fallback summary and exits 0 when stderr throws while building fails", async () => {
      const { exits } = await runMain({
        mode,
        api: fakeApi({ count: 1, baseRef: "main" }),
        buildSummary: () => {
          throw new RangeError("injected");
        },
        err: () => {
          throw throwingProxy();
        },
      });
      expect(exits).toEqual([0]);
      expect(readFileSync(summaryPath, "utf8")).toMatch(/^### QA handoff \(.+ mode\)\n\n.+\n$/);
      expect(readFileSync(summaryPath, "utf8")).not.toContain("#1 ");
    });

    it("exits 0 when stderr throws and the summary file cannot be written", async () => {
      const { exits } = await runMain({
        mode,
        api: fakeApi({ count: 1, baseRef: "main" }),
        env: { GITHUB_STEP_SUMMARY: join(dir, "missing", "summary.md") },
        err: () => {
          throw new Error("stderr is closed");
        },
      });
      expect(exits).toEqual([0]);
    });

    it("keeps the full summary and exits 1 when the run fails and stderr throws", async () => {
      const api = { ...fakeApi({ count: 1, baseRef: "main" }), listOpenPrs: async () => Promise.reject(new Error("API down")) };
      const { exits } = await runMain({
        mode,
        api,
        err: () => {
          throw new Error("stderr is closed");
        },
      });
      expect(exits).toEqual([1]);
      expect(readFileSync(summaryPath, "utf8")).toContain("ERROR: API down");
    });

    it("keeps the full summary and exits 0 when stdout throws", async () => {
      const { exits, errors } = await runMain({
        mode,
        api: fakeApi({ count: 1, baseRef: "main" }),
        out: () => {
          throw new Error("EPIPE");
        },
      });
      expect(exits).toEqual([0]);
      expect(errors).toEqual([]);
      expect(readFileSync(summaryPath, "utf8")).toContain("#1 ");
    });
  });

  it("still exits 2 on a bad argument or a missing token when stderr throws", async () => {
    const err = () => {
      throw new Error("stderr is closed");
    };
    const api = fakeApi({ count: 1, baseRef: "main" });
    expect((await runMain({ api, argv: ["--bogus", "x"], err })).exits).toEqual([2]);
    expect((await runMain({ api, env: { GITHUB_TOKEN: "", GH_TOKEN: "" }, err })).exits).toEqual([2]);
  });
});
