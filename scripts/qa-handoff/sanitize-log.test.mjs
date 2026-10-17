// @vitest-environment node

import { describe, expect, it } from "vitest";
import { handoffPr, resolveRequiredChecks, run } from "./run.mjs";
import { sanitizeLog } from "./sanitize-log.mjs";

const SHA = "a".repeat(40);
const UNSAFE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

describe("sanitizeLog", () => {
  it("flattens LF- and CRLF-injected titles and branch names onto one line", () => {
    expect(sanitizeLog("Fix bug\nqa-handoff: handed off")).toBe("Fix bug qa-handoff: handed off");
    expect(sanitizeLog("feature/x\r\n#7 forged: handed off")).toBe("feature/x  #7 forged: handed off");
  });

  it("replaces every control character and the Unicode line separators", () => {
    expect(sanitizeLog("a\u0000b\u0007c\u001Bd\u007Fe\u0085f\u009Fg\u2028h\u2029i\tj")).toBe("a b c d e f g h i j");
  });

  it("stringifies nullish and non-string input", () => {
    expect(sanitizeLog(undefined)).toBe("");
    expect(sanitizeLog(null)).toBe("");
    expect(sanitizeLog(42)).toBe("42");
  });

  it("caps over-length input with an ellipsis", () => {
    const capped = sanitizeLog("x".repeat(500));
    expect(capped).toHaveLength(200);
    expect(capped.endsWith("…")).toBe(true);
    expect(sanitizeLog("abcdef", 4)).toBe("abc…");
    expect(sanitizeLog("x".repeat(200))).toBe("x".repeat(200));
  });
});

describe("qa-handoff log paths", () => {
  function api({ baseRef = "main", checkName = "ci" } = {}) {
    return {
      getPr: async (number) => ({ number, state: "open", draft: false, base: { ref: baseRef }, head: { sha: SHA } }),
      listOpenPrs: async () => [],
      getBranchRequiredChecks: async () => [checkName],
      getProtectionRequiredChecks: async () => [checkName],
      listCheckRuns: async () => [{ id: 1, name: checkName, status: "in_progress" }],
      listStatuses: async () => [],
      listComments: async () => [],
    };
  }

  it("sanitizes a PR-controlled base ref in the no-op line", async () => {
    const lines = [];
    await handoffPr({ api: api({ baseRef: "main\r\n#7 forged: handed off" }), prNumber: 7, eventSha: SHA, mode: "report", requiredChecks: ["ci"], log: (line) => lines.push(line) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toMatch(UNSAFE);
    expect(lines[0]).toContain("base-not-main:main  #7 forged: handed off");
  });

  it("sanitizes check names in the required-check and per-PR lines", async () => {
    const checkName = "ci\nqa-handoff: forged";
    const lines = [];
    await run({ args: { repo: "o/r", mode: "report", pr: 7, sha: SHA }, api: api({ checkName }), env: {}, log: (line) => lines.push(line) });
    for (const line of lines) expect(line).not.toMatch(UNSAFE);
    expect(lines).toContain("required checks (GET branches/main): ci qa-handoff: forged");
    expect(lines.at(-1)).toContain("[ci qa-handoff: forged=pending]");
  });

  it("sanitizes the fallback REQUIRED_CHECKS names", async () => {
    const lines = [];
    const empty = { getBranchRequiredChecks: async () => [], getProtectionRequiredChecks: async () => [] };
    await resolveRequiredChecks(empty, { REQUIRED_CHECKS: "ci\u2028forged" }, (line) => lines.push(line));
    expect(lines.at(-1)).toBe("required checks (REQUIRED_CHECKS env): ci forged");
  });
});
