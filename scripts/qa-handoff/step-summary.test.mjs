// @vitest-environment node

import { describe, expect, it } from "vitest";
import { codeFence, stepSummary } from "./run.mjs";

// CommonMark: a closing fence is a line of the same fence character, at least
// as long as the opener, with nothing else after it (up to 3 spaces indent).
function closesEarly(summary) {
  const rows = summary.split("\n");
  const open = rows.findIndex((row) => /^`{3,}$/.test(row));
  const fence = rows[open];
  const close = rows.findIndex((row, i) => i > open && /^ {0,3}`+\s*$/.test(row) && row.trim().length >= fence.length);
  return { fence, close, last: rows.lastIndexOf(fence) };
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
  ])("handles %s", (_name, content, expected) => {
    expect(codeFence(content)).toBe(expected);
  });
});

describe("stepSummary", () => {
  it.each([
    ["single backtick", "branch: feat/`x`"],
    ["triple backticks", "branch: feat/```\n# injected"],
    ["tildes", "branch: feat/~~~\n# injected"],
    ["mixed", "branch: `a` ``` ~~~ ````` end"],
  ])("content with %s cannot close the fence", (_name, line) => {
    const summary = stepSummary("report", ["first", line, "last"]);
    const { fence, close, last } = closesEarly(summary);
    expect(fence.length).toBeGreaterThanOrEqual(3);
    // The only closing fence is the final one.
    expect(close).toBe(last);
    expect(summary.endsWith(`\n${fence}\n`)).toBe(true);
    expect(summary).toContain(line);
  });
});
