/**
 * Regression gate for drawing extraction.
 *
 * Runs the production extraction path over a checked-in corpus of drawings
 * with known-correct field values, and fails when per-field accuracy drops
 * below the configured floor.
 *
 * This exists because prompt, model, and threshold changes previously shipped
 * with no measured signal at all: the eval harness could only be pointed at
 * one drawing at a time, by hand, and CI checked types and unit tests but
 * never extraction quality. Post-hoc production monitoring
 * (`extraction_quality_summary`) tells you a change hurt after customers
 * absorbed it; this tells you before merge.
 *
 * Usage:
 *   npm --prefix worker run eval:gate -- --corpus worker/eval-corpus
 *   npm --prefix worker run eval:gate -- --corpus <dir> --floor 0.9 --json
 *
 * Exits 0 when every field meets its floor, 1 when any field is below it, and
 * 2 when the corpus is missing or unusable.
 */

import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadConfig } from "../config.js";
import { extractPdfText, inferDrawingSignalsFromPdf, renderPdfFirstPagePreview } from "../extraction/pdfDrawing.js";
import { runHybridExtraction } from "../extraction/hybridExtraction.js";
import { normalizeComparableFieldValue } from "../extraction/modelFallback.js";
import { CRITICAL_MODEL_FIELDS, type CriticalModelFieldName } from "../extraction/policy.js";
import type { PartRecord, WorkerConfig } from "../types.js";

/** One corpus case: a drawing plus the values a human confirmed it carries. */
export type CorpusCase = {
  /** Stable id, also used in reports. Defaults to the case filename stem. */
  id: string;
  /** Path to the PDF, relative to the corpus directory. */
  pdfPath: string;
  /** Known-correct values. Omit a field that the drawing genuinely lacks. */
  fields: Partial<Record<CriticalModelFieldName | "process", string>>;
  /** Optional free text describing why this drawing is in the corpus. */
  note?: string;
};

export type FieldAccuracy = {
  field: string;
  /** Cases where ground truth declares a value for this field. */
  applicable: number;
  correct: number;
  accuracy: number;
  floor: number;
  passed: boolean;
};

export type GateReport = {
  corpusDir: string;
  caseCount: number;
  fields: FieldAccuracy[];
  passed: boolean;
  failures: Array<{ caseId: string; field: string; expected: string; actual: string | null }>;
};

/** Per-field accuracy floors. Raise these as the corpus and pipeline improve. */
export const DEFAULT_FIELD_FLOORS: Record<string, number> = {
  partNumber: 0.9,
  revision: 0.85,
  description: 0.8,
  material: 0.85,
  finish: 0.75,
};

const GATED_FIELDS = CRITICAL_MODEL_FIELDS;

export function valuesMatch(expected: string, actual: string | null): boolean {
  return normalizeComparableFieldValue(expected) === normalizeComparableFieldValue(actual);
}

/**
 * Scores extraction results against a corpus.
 *
 * A field counts only for cases whose ground truth declares it, so a corpus of
 * drawings that legitimately lack a finish callout does not drag the finish
 * floor down.
 */
export function scoreCorpus(
  results: Array<{ caseId: string; expected: CorpusCase["fields"]; actual: Partial<Record<string, string | null>> }>,
  floors: Record<string, number> = DEFAULT_FIELD_FLOORS,
): Omit<GateReport, "corpusDir"> {
  const failures: GateReport["failures"] = [];

  const fields = GATED_FIELDS.map((field) => {
    let applicable = 0;
    let correct = 0;

    for (const result of results) {
      const expected = result.expected[field];
      if (expected === undefined) {
        continue;
      }

      applicable += 1;
      const actual = result.actual[field] ?? null;

      if (valuesMatch(expected, actual)) {
        correct += 1;
      } else {
        failures.push({ caseId: result.caseId, field, expected, actual });
      }
    }

    const floor = floors[field] ?? 0;
    // A field with no applicable cases cannot fail; it simply is not measured.
    const accuracy = applicable === 0 ? 1 : correct / applicable;

    return {
      field,
      applicable,
      correct,
      accuracy,
      floor,
      passed: accuracy >= floor,
    };
  });

  return {
    caseCount: results.length,
    fields,
    passed: fields.every((field) => field.passed),
    failures,
  };
}

export async function loadCorpus(corpusDir: string): Promise<CorpusCase[]> {
  const casesDir = path.join(corpusDir, "cases");
  const entries = await fs.readdir(casesDir).catch(() => {
    throw new Error(
      `No corpus found at ${casesDir}. See worker/eval-corpus/README.md for the expected layout.`,
    );
  });

  const cases: CorpusCase[] = [];

  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    const raw = await fs.readFile(path.join(casesDir, entry), "utf8");
    const parsed = JSON.parse(raw) as Partial<CorpusCase>;

    if (!parsed.pdfPath || !parsed.fields) {
      throw new Error(`Corpus case ${entry} must define "pdfPath" and "fields".`);
    }

    cases.push({
      id: parsed.id ?? path.basename(entry, ".json"),
      pdfPath: parsed.pdfPath,
      fields: parsed.fields,
      note: parsed.note,
    });
  }

  return cases;
}

function makePartRecord(caseId: string): PartRecord {
  return {
    id: `eval-${caseId}`,
    job_id: "eval-job",
    name: caseId,
    quantity: 1,
  } as PartRecord;
}

async function runCase(
  config: WorkerConfig,
  corpusDir: string,
  corpusCase: CorpusCase,
  runDir: string,
) {
  const pdfPath = path.resolve(corpusDir, corpusCase.pdfPath);
  const pdfText = await extractPdfText(pdfPath);
  const previewPath = path.join(runDir, `${corpusCase.id}-page-1.png`);
  const preview = await renderPdfFirstPagePreview(pdfPath, previewPath).catch(() => null);

  const drawingFile = {
    id: `eval-file-${corpusCase.id}`,
    original_name: path.basename(corpusCase.pdfPath),
    storage_path: pdfPath,
    kind: "drawing",
  } as never;

  const extraction = await runHybridExtraction({
    part: makePartRecord(corpusCase.id),
    cadFile: null,
    drawingFile,
    pdfText,
    drawingPath: pdfPath,
    previewPagePath: preview?.localPath ?? null,
    runDir,
    config,
  });

  return {
    caseId: corpusCase.id,
    expected: corpusCase.fields,
    actual: {
      partNumber: extraction.extractedPartNumberRaw.value,
      revision: extraction.extractedRevisionRaw.value,
      description: extraction.extractedDescriptionRaw.value,
      material: extraction.material.raw,
      finish: extraction.extractedFinishRaw.value,
    } as Partial<Record<string, string | null>>,
  };
}

/**
 * Default corpus location, resolved from this module rather than the process
 * cwd so `npm --prefix worker run eval:gate` and a repo-root invocation agree.
 */
const DEFAULT_CORPUS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "eval-corpus",
);

function parseArgs(argv: string[]) {
  let corpusDir = DEFAULT_CORPUS_DIR;
  let json = false;
  const floors = { ...DEFAULT_FIELD_FLOORS };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--corpus") {
      corpusDir = path.resolve(argv[++index] ?? corpusDir);
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--floor") {
      const value = Number.parseFloat(argv[++index] ?? "");
      if (Number.isFinite(value)) {
        for (const field of Object.keys(floors)) {
          floors[field] = value;
        }
      }
    }
  }

  return { corpusDir, json, floors };
}

function renderReport(report: GateReport) {
  const lines = [
    `Extraction gate — ${report.caseCount} case(s) from ${report.corpusDir}`,
    "",
    "field           applicable  correct  accuracy  floor   result",
  ];

  for (const field of report.fields) {
    lines.push(
      [
        field.field.padEnd(15),
        String(field.applicable).padStart(10),
        String(field.correct).padStart(9),
        `${(field.accuracy * 100).toFixed(1)}%`.padStart(10),
        `${(field.floor * 100).toFixed(0)}%`.padStart(7),
        field.passed ? "  PASS" : "  FAIL",
      ].join(""),
    );
  }

  if (report.failures.length > 0) {
    lines.push("", "Mismatches:");
    for (const failure of report.failures.slice(0, 25)) {
      lines.push(
        `  ${failure.caseId} ${failure.field}: expected ${JSON.stringify(failure.expected)}, got ${JSON.stringify(failure.actual)}`,
      );
    }
    if (report.failures.length > 25) {
      lines.push(`  ... and ${report.failures.length - 25} more`);
    }
  }

  return lines.join("\n");
}

async function main() {
  const { corpusDir, json, floors } = parseArgs(process.argv.slice(2));

  let cases: CorpusCase[];
  try {
    cases = await loadCorpus(corpusDir);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }

  if (cases.length === 0) {
    console.error(
      `Corpus at ${corpusDir} contains no cases. See worker/eval-corpus/README.md for how to add one.`,
    );
    process.exit(2);
  }

  const config = loadConfig();
  await fs.mkdir(config.workerTempDir, { recursive: true });
  const runDir = await fs.mkdtemp(path.join(config.workerTempDir, "eval-gate-"));

  try {
    const results = [];
    for (const corpusCase of cases) {
      results.push(await runCase(config, corpusDir, corpusCase, runDir));
    }

    const report: GateReport = { corpusDir, ...scoreCorpus(results, floors) };

    console.log(json ? JSON.stringify(report, null, 2) : renderReport(report));
    process.exit(report.passed ? 0 : 1);
  } finally {
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// Only run when invoked directly, so the scoring helpers stay unit-testable.
if (process.argv[1] && process.argv[1].includes("extractEvalGate")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(2);
  });
}
