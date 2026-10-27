/**
 * Decides whether the `ci` job fails on the extraction gate (OVD-869).
 *
 * The gate result is read only from the machine line
 * `EXTRACTION_GATE_RESULT=pass|fail|error`; a missing, duplicate or unknown
 * line counts as `error`. Mode is `enforce` only when set exactly; anything
 * else is `report`, which never fails on the line. Enforce fails closed on fail and error.
 * A run with no checked-in corpus is a skip, not a failure. Mode governs only
 * the parsed line: any non-empty, non-success extraction-gate job result fails
 * in every mode, mirroring the success requirement in ci.yml's dependency step.
 *
 * Usage (CI): EXTRACTION_GATE_MODE=<mode> EXTRACTION_GATE_OUTPUT=<text>
 *   EXTRACTION_GATE_CORPUS=<true|false> EXTRACTION_GATE_JOB_RESULT=<result>
 *   node scripts/extraction-gate-decision.mjs
 */
import { isEntryPoint } from "./lib/entry-point.mjs";
import { appendFileSync } from "node:fs";

export const RESULT_LINE_PREFIX = "EXTRACTION_GATE_RESULT=";
export const RESULTS = ["pass", "fail", "error"];

/** `enforce` only when set exactly; unset or any other value reports. */
export function normalizeMode(mode) {
  return mode === "enforce" ? "enforce" : "report";
}

/** Parse the single machine result line out of raw gate output. */
export function parseGateResult(output) {
  const lines = String(output ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(RESULT_LINE_PREFIX));
  if (lines.length === 0) return { result: "error", reason: "missing result line" };
  if (lines.length > 1) return { result: "error", reason: "duplicate result lines" };
  const value = lines[0].slice(RESULT_LINE_PREFIX.length);
  if (!RESULTS.includes(value)) return { result: "error", reason: `unknown result "${value}"` };
  return { result: value, reason: null };
}

/**
 * @param {{ mode?: string, output?: string, corpusPresent?: string, jobResult?: string }} input
 * @returns {{ mode: string, result: string, exitCode: 0 | 1, annotation: string, summary: string }}
 */
export function decideExtractionGate({ mode, output, corpusPresent, jobResult } = {}) {
  const effectiveMode = normalizeMode(mode);
  const parsed = parseGateResult(output);
  const skipped = corpusPresent === "false" && parsed.reason === "missing result line";

  let result = parsed.result;
  let level;
  let exitCode = 0;
  let message;
  if (jobResult && jobResult !== "success") {
    level = "error";
    exitCode = 1;
    message = "Extraction gate job failed; ci fails in every mode.";
  } else if (skipped) {
    result = "skipped";
    level = "notice";
    message = "Extraction gate skipped: no eval corpus checked in.";
  } else if (result === "pass") {
    level = "notice";
    message = "Extraction gate passed.";
  } else {
    const detail = result === "fail" ? "failed its quality floors" : `errored (${parsed.reason ?? "gate crashed"})`;
    if (effectiveMode === "enforce") {
      level = "error";
      exitCode = 1;
      message = `Extraction gate ${detail}; enforce mode fails ci.`;
    } else {
      level = "warning";
      message = `Extraction gate ${detail}; report mode, not failing ci.`;
    }
  }

  const annotation = `::${level} title=Extraction gate (${effectiveMode})::${message}`;
  const summary = [
    "### Extraction gate",
    "",
    "| Mode | Result | Outcome |",
    "| --- | --- | --- |",
    `| ${effectiveMode} | ${result} | ${exitCode === 0 ? "ci not failed" : "ci failed"} |`,
    "",
    message,
    "",
  ].join("\n");

  return { mode: effectiveMode, result, exitCode, annotation, summary };
}

if (isEntryPoint(import.meta.url)) {
  const decision = decideExtractionGate({
    mode: process.env.EXTRACTION_GATE_MODE,
    output: process.env.EXTRACTION_GATE_OUTPUT,
    corpusPresent: process.env.EXTRACTION_GATE_CORPUS,
    jobResult: process.env.EXTRACTION_GATE_JOB_RESULT,
  });
  console.log(`extraction-gate mode=${decision.mode} result=${decision.result} exit=${decision.exitCode}`);
  console.log(decision.annotation);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, decision.summary);
  }
  process.exitCode = decision.exitCode;
}
