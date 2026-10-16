// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decideExtractionGate, normalizeMode, parseGateResult } from "./extraction-gate-decision.mjs";

const OUTPUTS = {
  pass: "eval:gate exited 0\nEXTRACTION_GATE_RESULT=pass\n",
  fail: "eval:gate exited 1\nEXTRACTION_GATE_RESULT=fail\n",
  error: "eval:gate exited 2\nEXTRACTION_GATE_RESULT=error\n",
  missing: "",
  duplicate: "EXTRACTION_GATE_RESULT=pass\nEXTRACTION_GATE_RESULT=pass\n",
};

const MODES = { report: "report", enforce: "enforce", unset: undefined, garbage: "Enforce!" };

// [exitCode, annotation level] per gate output, for report-like and enforce modes.
const EXPECTED = {
  report: {
    pass: [0, "notice"],
    fail: [0, "warning"],
    error: [0, "warning"],
    missing: [0, "warning"],
    duplicate: [0, "warning"],
  },
  enforce: {
    pass: [0, "notice"],
    fail: [1, "error"],
    error: [1, "error"],
    missing: [1, "error"],
    duplicate: [1, "error"],
  },
};

describe("extraction gate decision", () => {
  for (const [modeName, mode] of Object.entries(MODES)) {
    const expectations = modeName === "enforce" ? EXPECTED.enforce : EXPECTED.report;
    for (const [outputName, output] of Object.entries(OUTPUTS)) {
      const [exitCode, level] = expectations[outputName];
      it(`${outputName} output in ${modeName} mode exits ${exitCode} with ${level}`, () => {
        const decision = decideExtractionGate({ mode, output, corpusPresent: "true" });
        expect(decision.exitCode).toBe(exitCode);
        expect(decision.annotation.startsWith(`::${level} `)).toBe(true);
        expect(decision.summary).toContain("### Extraction gate");
      });
    }
  }

  it("only an exact enforce value enforces", () => {
    expect(normalizeMode("enforce")).toBe("enforce");
    for (const mode of [undefined, "", "report", "ENFORCE", " enforce", "true"]) {
      expect(normalizeMode(mode)).toBe("report");
    }
  });

  it("reads only the machine line, never free text", () => {
    expect(parseGateResult("Gate passed: all floors met\n").result).toBe("error");
    expect(parseGateResult("EXTRACTION_GATE_RESULT=PASS").result).toBe("error");
    expect(parseGateResult("noise\nEXTRACTION_GATE_RESULT=fail\r\nmore noise").result).toBe("fail");
  });

  it("treats a run with no corpus as a skip in every mode", () => {
    for (const mode of Object.values(MODES)) {
      const decision = decideExtractionGate({ mode, output: "", corpusPresent: "false" });
      expect(decision.result).toBe("skipped");
      expect(decision.exitCode).toBe(0);
      expect(decision.annotation.startsWith("::notice ")).toBe(true);
    }
  });

  it("fails closed in enforce when the corpus check never reported", () => {
    const decision = decideExtractionGate({ mode: "enforce", output: "", corpusPresent: "" });
    expect(decision.result).toBe("error");
    expect(decision.exitCode).toBe(1);
  });
});
