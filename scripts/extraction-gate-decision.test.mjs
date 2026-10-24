// @vitest-environment node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
      it.each([undefined, "", "success"])(`${outputName} output in ${modeName} mode with job result %s exits ${exitCode} with ${level}`, (jobResult) => {
        const decision = decideExtractionGate({ mode, output, corpusPresent: "true", jobResult });
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

describe("extraction gate job failure", () => {
  it("checks out the entry helper and requires evidence from each PR-2 CI gate", () => {
    const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    expect(workflow).toMatch(/sparse-checkout: \|\n\s+scripts\/extraction-gate-decision.mjs\n\s+scripts\/lib\/entry-point.mjs/);
    for (const [name, command, evidence] of [
      ["Verify migration lineage", 'npm run verify:migration-lineage -- --against-base | tee "$RUNNER_TEMP/migration-lineage.log"', "if ! grep -Fq 'Supabase migration-lineage verification passed'"],
      ["Check provider integrations", 'npm run --silent provider:check | tee "$RUNNER_TEMP/provider-check.json"', "jq -e '.ok == true'"],
      ["Decide extraction gate", 'node scripts/extraction-gate-decision.mjs | tee "$RUNNER_TEMP/extraction-gate-decision.log"', "if ! grep -Eq '^extraction-gate mode=\\S+ result=\\S+ exit='"],
    ]) {
      const step = workflow.split(/\n {6}- name: /).find((block) => block.startsWith(`${name}\n`));
      expect(step, name).toBeDefined();
      expect(step).toContain("set -euo pipefail");
      expect(step).toContain(command);
      expect(step).toContain(evidence);
      expect(step).toMatch(/echo "::error::[^\n]+\n\s+exit 1/);
    }
    expect(workflow).toContain('test -s "$RUNNER_TEMP/provider-check.json"');
  });

  it.each(["failure", "cancelled", "skipped", "unknown"])("fails ci for job result %s in every mode whatever the parsed line says", (jobResult) => {
    for (const mode of Object.values(MODES)) {
      for (const output of Object.values(OUTPUTS)) {
        for (const corpusPresent of ["true", "false"]) {
          const decision = decideExtractionGate({ mode, output, corpusPresent, jobResult });
          expect(decision.exitCode).toBe(1);
          expect(decision.result).toBe(parseGateResult(output).result);
          expect(decision.annotation).toBe(`::error title=Extraction gate (${normalizeMode(mode)})::Extraction gate job failed; ci fails in every mode.`);
          expect(decision.summary).toContain("ci failed");
        }
      }
    }
  });

  it.each(Object.entries(MODES))("the CLI fails a cancelled job with decision evidence in %s mode", (_modeName, mode) => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./extraction-gate-decision.mjs", import.meta.url))], {
      encoding: "utf8",
      env: {
        ...process.env,
        EXTRACTION_GATE_MODE: mode ?? "",
        EXTRACTION_GATE_OUTPUT: "",
        EXTRACTION_GATE_CORPUS: "",
        EXTRACTION_GATE_JOB_RESULT: "cancelled",
        GITHUB_STEP_SUMMARY: "",
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`extraction-gate mode=${normalizeMode(mode)} result=error exit=1\n`);
    expect(result.stdout).toContain(`::error title=Extraction gate (${normalizeMode(mode)})::Extraction gate job failed; ci fails in every mode.`);
  });

  it("ci.yml unconditionally requires job success in Check dependency results", () => {
    const workflow = readFileSync(fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url)), "utf8");
    const start = workflow.indexOf("- name: Check dependency results");
    const end = workflow.indexOf("- name:", start + 1);
    expect(start).toBeGreaterThan(-1);
    const step = workflow.slice(start, end);
    expect(step).toContain("EXTRACTION_GATE_RESULT: ${{ needs.extraction-gate.result }}");
    expect(step).toMatch(
      /\n {10}if \[ "\$EXTRACTION_GATE_RESULT" != "success" \]; then\n {12}exit 1\n {10}fi\n/,
    );
    // The check must not depend on the mode: the step neither reads it nor is skipped by it.
    expect(step).not.toContain("EXTRACTION_GATE_MODE");
    expect(step).not.toMatch(/^\s+if:/m);
  });

  it("gate steps exit non-zero on a crash after emitting the result line", () => {
    const workflow = readFileSync(fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url)), "utf8");
    const crashExits = workflow.match(/if \[ "\$result" = "error" \]; then exit "\$code"; fi/g) ?? [];
    expect(crashExits).toHaveLength(2);
  });
});
