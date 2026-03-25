import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import {
  extractPdfText,
  renderPdfTitleBlockCrop,
  renderPdfFirstPagePreview,
  inferDrawingSignalsFromPdf,
} from "../extraction/pdfDrawing.js";
import {
  shouldTriggerDrawingModelFallback,
  serializeParserContext,
  normalizeComparableFieldValue,
} from "../extraction/modelFallback.js";
import {
  inferProvider,
  createProvider,
  buildEvalPromptParts,
  isEvalError,
  type EvalRunOutput,
  type EvalErrorOutput,
  type EvalModelInput,
  type EvalModelOutput,
} from "./extractEvalProviders.js";
import { estimateCost } from "./extractEvalCosts.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GroundTruthFile = {
  pdfPath: string;
  createdAt: string;
  fields: {
    partNumber?: string;
    revision?: string;
    description?: string;
    material?: string;
    finish?: string;
    process?: string;
  };
};

type ParsedArgs = {
  pdfPaths: string[];
  models: string[];
  providerOverride?: string;
  json: boolean;
  groundTruthPath?: string;
  noParser: boolean;
  parserOnly: boolean;
  saveGroundTruth: boolean;
  timeoutMs: number;
};

const FIELD_NAMES = [
  "partNumber",
  "revision",
  "description",
  "material",
  "finish",
  "process",
] as const;

type FieldName = (typeof FIELD_NAMES)[number];

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

/**
 * Parse process.argv.slice(2) into structured options.
 * Throws with a usage message if no PDF paths are provided.
 */
export function parseArgs(argv: string[] = process.argv.slice(2)): ParsedArgs {
  const usage = `Usage: npm --prefix worker run extract:eval -- [options] <pdf> [pdf2 ...]

Options:
  --models <list>          Comma-separated model IDs. Default: gpt-5.4,claude-sonnet-4-6,openai/gpt-4.1-mini
  --provider <name>        Override provider for all models: openai|anthropic|openrouter
  --json                   Output full structured JSON instead of ASCII table
  --ground-truth <f>       Path to ground-truth JSON for scoring (adds GT column)
  --no-parser              Omit parser context from model prompt (parser still runs for images)
  --parser-only            Skip all model calls, show parser output only
  --save-ground-truth      Save run output as <pdf>.ground-truth.json
  --timeout <ms>           Per-model timeout in ms. Default: 30000`;

  const pdfPaths: string[] = [];
  let models: string[] = ["gpt-5.4", "claude-sonnet-4-6", "openai/gpt-4.1-mini"];
  let providerOverride: string | undefined;
  let json = false;
  let groundTruthPath: string | undefined;
  let noParser = false;
  let parserOnly = false;
  let saveGroundTruth = false;
  let timeoutMs = 30000;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--models") {
      const val = argv[++i];
      if (!val) throw new Error(`${usage}\n\nError: --models requires a value`);
      models = val.split(",").map((m) => m.trim()).filter(Boolean);
    } else if (arg === "--provider") {
      providerOverride = argv[++i];
      if (!providerOverride) throw new Error(`${usage}\n\nError: --provider requires a value`);
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--ground-truth") {
      const val = argv[++i];
      if (!val) throw new Error(`${usage}\n\nError: --ground-truth requires a value`);
      groundTruthPath = path.resolve(val);
    } else if (arg === "--no-parser") {
      noParser = true;
    } else if (arg === "--parser-only") {
      parserOnly = true;
    } else if (arg === "--save-ground-truth") {
      saveGroundTruth = true;
    } else if (arg === "--timeout") {
      const val = argv[++i];
      if (!val) throw new Error(`${usage}\n\nError: --timeout requires a value`);
      const parsed = parseInt(val, 10);
      if (isNaN(parsed) || parsed <= 0) throw new Error(`${usage}\n\nError: --timeout must be a positive integer`);
      timeoutMs = parsed;
    } else if (!arg.startsWith("--")) {
      pdfPaths.push(path.resolve(arg));
    } else {
      throw new Error(`${usage}\n\nError: Unknown option "${arg}"`);
    }
  }

  if (pdfPaths.length === 0) {
    throw new Error(usage);
  }

  return {
    pdfPaths,
    models,
    providerOverride,
    json,
    groundTruthPath,
    noParser,
    parserOnly,
    saveGroundTruth,
    timeoutMs,
  };
}

// ---------------------------------------------------------------------------
// API key loading
// ---------------------------------------------------------------------------

async function loadApiKeys(): Promise<{
  openai?: string;
  anthropic?: string;
  openrouter?: string;
}> {
  // Try loading dotenv from repo root or worker/.env
  try {
    const { config } = await import("dotenv");
    const workerDir = new URL("../..", import.meta.url).pathname;
    const repoRoot = path.resolve(workerDir, "..");
    // Try worker/.env first, then repo root .env
    const tried = [path.join(workerDir, ".env"), path.join(repoRoot, ".env")];
    for (const envPath of tried) {
      try {
        config({ path: envPath, override: false });
      } catch {
        // ignore
      }
    }
  } catch {
    // dotenv not available or failed; use process.env as-is
  }

  return {
    openai: process.env.OPENAI_API_KEY || undefined,
    anthropic: process.env.ANTHROPIC_API_KEY || undefined,
    openrouter: process.env.OPENROUTER_API_KEY || undefined,
  };
}

// ---------------------------------------------------------------------------
// Confidence icon helpers
// ---------------------------------------------------------------------------

function fieldConfidenceIcon(value: string | null | undefined, confidence: number): string {
  if (!value) return "✗";
  if (confidence >= 0.8) return "✓";
  return "~";
}

function gtIcon(modelValue: string | null | undefined, gtValue: string | undefined): string {
  if (gtValue === undefined) return "";
  const norm = normalizeComparableFieldValue(modelValue ?? null);
  const gtNorm = normalizeComparableFieldValue(gtValue);
  return norm === gtNorm ? "✓" : "✗";
}

// ---------------------------------------------------------------------------
// ASCII table rendering
// ---------------------------------------------------------------------------

function padEnd(str: string, len: number): string {
  // Pad to visual length, accounting for multi-byte chars is complex;
  // we approximate by treating each emoji as 2 chars visually.
  const visual = str.replace(/[✓✗~!]/g, "xx");
  const diff = len - visual.length;
  return str + " ".repeat(Math.max(0, diff));
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatCost(output: EvalModelOutput): string {
  let costUsd: number | null = null;
  let approx = true;

  if (output.estimatedCostUsd !== null) {
    // Provider-reported (OpenRouter)
    costUsd = output.estimatedCostUsd;
    approx = false;
  } else {
    const est = estimateCost(output.modelName, output.inputTokens, output.outputTokens);
    if (est) {
      costUsd = est.costUsd;
      approx = est.isApproximate || !Object.keys({}).length; // always prefix ~ from static table
      approx = true; // static table always gets ~
    }
  }

  if (costUsd === null) return `~$?.?????`;
  return `${approx ? "~" : ""}$${costUsd.toFixed(5)}`;
}

function renderAsciiTable(
  modelResults: Array<{ modelId: string; output: EvalRunOutput; totalDurationMs: number }>,
  groundTruth: GroundTruthFile | undefined,
): string {
  const fieldColWidth = 16;
  const modelColWidth = 26;
  const hasGt = groundTruth !== undefined;
  const gtColWidth = hasGt ? 6 : 0;

  const modelCount = modelResults.length;
  const totalWidth =
    fieldColWidth + 2 +
    modelCount * (modelColWidth + 3) +
    (hasGt ? gtColWidth + 3 : 0) +
    1;

  function hRule(
    left: string,
    mid: string,
    right: string,
    fill: string,
  ): string {
    const parts = ["─".repeat(fieldColWidth + 2)];
    for (let i = 0; i < modelCount; i++) {
      parts.push("─".repeat(modelColWidth + 2));
    }
    if (hasGt) parts.push("─".repeat(gtColWidth + 2));
    return left + parts.join(mid) + right;
  }

  const lines: string[] = [];

  // Top border
  lines.push(hRule("┌", "┬", "┐", "─"));

  // Header row
  {
    let row = "│ " + padEnd("Field", fieldColWidth) + " ";
    for (const { modelId } of modelResults) {
      row += "│ " + padEnd(modelId, modelColWidth) + " ";
    }
    if (hasGt) row += "│ " + padEnd("GT", gtColWidth) + " ";
    row += "│";
    lines.push(row);
  }

  // Header separator
  lines.push(hRule("├", "┼", "┤", "─"));

  // Field rows
  for (const fieldName of FIELD_NAMES) {
    let row = "│ " + padEnd(fieldName, fieldColWidth) + " ";
    for (const { output } of modelResults) {
      if (isEvalError(output)) {
        row += "│ " + padEnd("(error)", modelColWidth) + " ";
      } else {
        const field = output.fields[fieldName];
        const val = field.value ?? "(null)";
        const conf = field.confidence;
        const icon = fieldConfidenceIcon(field.value, conf);
        const cell = `${val}  ${conf.toFixed(2)} ${icon}`;
        row += "│ " + padEnd(cell, modelColWidth) + " ";
      }
    }
    if (hasGt) {
      // Use first non-error model for GT comparison
      const firstSuccess = modelResults.find((r) => !isEvalError(r.output));
      if (firstSuccess && !isEvalError(firstSuccess.output)) {
        const modelVal = firstSuccess.output.fields[fieldName].value;
        const icon = gtIcon(modelVal, groundTruth?.fields[fieldName]);
        row += "│ " + padEnd(icon, gtColWidth) + " ";
      } else {
        row += "│ " + padEnd("", gtColWidth) + " ";
      }
    }
    row += "│";
    lines.push(row);
  }

  // Status separator
  lines.push(hRule("├", "┼", "┤", "─"));

  // Status row
  {
    let row = "│ " + padEnd("Status", fieldColWidth) + " ";
    for (const { output } of modelResults) {
      if (isEvalError(output)) {
        const cell = `${output.errorType}: ${output.errorMessage}`.slice(0, modelColWidth - 1);
        row += "│ " + padEnd(cell, modelColWidth) + " ";
      } else {
        const reviewNeeded = FIELD_NAMES.filter((f) => {
          const field = output.fields[f];
          return field.confidence < 0.8 || !field.value;
        });
        const cell =
          reviewNeeded.length === 0
            ? "approved"
            : `needs_review (${reviewNeeded.join(", ")})`.slice(0, modelColWidth - 1);
        row += "│ " + padEnd(cell, modelColWidth) + " ";
      }
    }
    if (hasGt) row += "│ " + padEnd("", gtColWidth) + " ";
    row += "│";
    lines.push(row);
  }

  // Duration row
  {
    let row = "│ " + padEnd("Duration", fieldColWidth) + " ";
    for (const { totalDurationMs } of modelResults) {
      row += "│ " + padEnd(formatDuration(totalDurationMs), modelColWidth) + " ";
    }
    if (hasGt) row += "│ " + padEnd("", gtColWidth) + " ";
    row += "│";
    lines.push(row);
  }

  // Input tokens row
  {
    let row = "│ " + padEnd("Input tokens", fieldColWidth) + " ";
    for (const { output } of modelResults) {
      const val = isEvalError(output) ? "-" : output.inputTokens.toLocaleString();
      row += "│ " + padEnd(val, modelColWidth) + " ";
    }
    if (hasGt) row += "│ " + padEnd("", gtColWidth) + " ";
    row += "│";
    lines.push(row);
  }

  // Output tokens row
  {
    let row = "│ " + padEnd("Output tokens", fieldColWidth) + " ";
    for (const { output } of modelResults) {
      const val = isEvalError(output) ? "-" : output.outputTokens.toLocaleString();
      row += "│ " + padEnd(val, modelColWidth) + " ";
    }
    if (hasGt) row += "│ " + padEnd("", gtColWidth) + " ";
    row += "│";
    lines.push(row);
  }

  // Cost row
  {
    let row = "│ " + padEnd("Cost (USD)", fieldColWidth) + " ";
    for (const { output } of modelResults) {
      const val = isEvalError(output) ? "-" : formatCost(output as EvalModelOutput);
      row += "│ " + padEnd(val, modelColWidth) + " ";
    }
    if (hasGt) row += "│ " + padEnd("", gtColWidth) + " ";
    row += "│";
    lines.push(row);
  }

  // Bottom border
  lines.push(hRule("└", "┴", "┘", "─"));

  // Legend
  lines.push("Legend: ✓ confident  ~ review_needed  ✗ missing/failed  ! value differs from parser");

  void totalWidth; // suppress unused variable warning

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, modelId: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        Object.assign(new Error(`Timed out after ${ms}ms`), {
          _isTimeout: true,
          modelId,
        }),
      );
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Run one model (two-attempt sequence)
// ---------------------------------------------------------------------------

async function runModel(opts: {
  modelId: string;
  providerOverride: string | undefined;
  apiKeys: { openai?: string; anthropic?: string; openrouter?: string };
  evalInput: Omit<EvalModelInput, "attempt">;
  timeoutMs: number;
}): Promise<{ output: EvalRunOutput; totalDurationMs: number }> {
  const { modelId, providerOverride, apiKeys, evalInput, timeoutMs } = opts;
  const providerName = inferProvider(modelId, providerOverride);
  const provider = createProvider(providerName, apiKeys);

  const start = Date.now();

  if (!provider) {
    const errOutput: EvalErrorOutput = {
      modelName: modelId,
      errorType: "unknown",
      errorMessage: "API key not set",
      durationMs: 0,
    };
    return { output: errOutput, totalDurationMs: 0 };
  }

  let result: EvalRunOutput;

  try {
    // Attempt 1: title_block_crop
    const attempt1Promise = provider.run({ ...evalInput, attempt: "title_block_crop" }, modelId);
    result = await withTimeout(attempt1Promise, timeoutMs, modelId);

    // Attempt 2: full_page if titleBlockSufficient === false
    if (!isEvalError(result) && result.fields.titleBlockSufficient === false) {
      const attempt2Promise = provider.run({ ...evalInput, attempt: "full_page" }, modelId);
      const remaining = timeoutMs - (Date.now() - start);
      const result2 = await withTimeout(attempt2Promise, Math.max(remaining, 1), modelId);
      result = result2;
    }
  } catch (err: unknown) {
    const isTimeout =
      err instanceof Error &&
      (err as Error & { _isTimeout?: boolean })._isTimeout === true;
    const errOutput: EvalErrorOutput = {
      modelName: modelId,
      errorType: isTimeout ? "timeout" : "unknown",
      errorMessage: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
    return { output: errOutput, totalDurationMs: Date.now() - start };
  }

  return { output: result, totalDurationMs: Date.now() - start };
}

// ---------------------------------------------------------------------------
// Ground truth save helpers
// ---------------------------------------------------------------------------

async function promptAccept(rl: readline.Interface, prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(!answer || answer.trim().toLowerCase() === "y" || answer.trim() === "");
    });
  });
}

async function saveGroundTruthFile(opts: {
  pdfPath: string;
  modelResults: Array<{ modelId: string; output: EvalRunOutput; totalDurationMs: number }>;
  isTty: boolean;
  jsonMode: boolean;
}): Promise<void> {
  const { pdfPath, modelResults, isTty, jsonMode } = opts;

  // Collect fields from first successful model
  const firstSuccess = modelResults.find((r) => !isEvalError(r.output));
  if (!firstSuccess || isEvalError(firstSuccess.output)) {
    console.error("Cannot save ground truth: no successful model output");
    return;
  }

  const fields: GroundTruthFile["fields"] = {};
  const shouldPrompt = isTty && !jsonMode;

  let rl: readline.Interface | null = null;
  if (shouldPrompt) {
    rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  }

  try {
    for (const fieldName of FIELD_NAMES) {
      const field = firstSuccess.output.fields[fieldName];
      if (!field.value) continue;

      // Check if any model has review_needed for this field
      const anyReviewNeeded = modelResults.some(
        (r) => !isEvalError(r.output) && r.output.fields[fieldName].confidence < 0.8,
      );

      if (shouldPrompt && anyReviewNeeded && rl) {
        const accepted = await promptAccept(
          rl,
          `  Accept "${field.value}" for ${fieldName}? [Y/n] `,
        );
        if (accepted) {
          fields[fieldName] = field.value;
        }
      } else {
        fields[fieldName] = field.value;
      }
    }
  } finally {
    if (rl) rl.close();
  }

  const gtFile: GroundTruthFile = {
    pdfPath,
    createdAt: new Date().toISOString(),
    fields,
  };

  const pdfDir = path.dirname(pdfPath);
  const pdfBase = path.basename(pdfPath, path.extname(pdfPath));
  const gtPath = path.join(pdfDir, `${pdfBase}.ground-truth.json`);
  await fs.writeFile(gtPath, JSON.stringify(gtFile, null, 2) + "\n", "utf8");
  console.error(`Ground truth saved to: ${gtPath}`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * Entry point for the extractEval CLI tool.
 * Runs extraction eval across multiple models and PDFs, rendering results as
 * ASCII table or JSON.
 */
export async function main(): Promise<void> {
  const args = parseArgs();
  const apiKeys = await loadApiKeys();

  // Load ground truth file once if specified
  let groundTruth: GroundTruthFile | undefined;
  if (args.groundTruthPath) {
    try {
      const raw = await fs.readFile(args.groundTruthPath, "utf8");
      groundTruth = JSON.parse(raw) as GroundTruthFile;
    } catch (err) {
      console.error(
        `Warning: Could not load ground truth from ${args.groundTruthPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  for (const pdfPath of args.pdfPaths) {
    const baseName = path.basename(pdfPath, path.extname(pdfPath));
    let runDir: string;

    try {
      runDir = await fs.mkdtemp(path.join(os.tmpdir(), "overdrafter-drawing-smoke-"));
    } catch (err) {
      console.error(`Error creating tmp dir: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    if (!args.json) {
      console.log(`\nPDF: ${path.basename(pdfPath)}`);
      console.log(`Run dir: ${runDir}`);
    }

    // Step 3: extractPdfText
    let pdfText: Awaited<ReturnType<typeof extractPdfText>> = null;
    try {
      pdfText = await extractPdfText(pdfPath);
    } catch (err) {
      console.error(`Error extracting PDF text: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    // Step 4: renderPdfTitleBlockCrop
    let titleBlockCropPath: string | null = null;
    try {
      const asset = await renderPdfTitleBlockCrop(pdfPath, path.join(runDir, "drawing-title-block.png"));
      titleBlockCropPath = asset?.localPath ?? null;
    } catch {
      titleBlockCropPath = null;
    }

    // Step 5: renderPdfFirstPagePreview
    let fullPagePath: string | null = null;
    try {
      const asset = await renderPdfFirstPagePreview(pdfPath, path.join(runDir, "drawing-page-1.png"));
      fullPagePath = asset?.localPath ?? null;
    } catch {
      fullPagePath = null;
    }

    // Step 6: inferDrawingSignalsFromPdf
    const drawingSignals = inferDrawingSignalsFromPdf({ baseName, pdfText });

    // Step 7: Print parser output
    if (!args.json) {
      console.log("\nParser output (deterministic):");
      for (const fieldName of FIELD_NAMES) {
        const field = drawingSignals[fieldName];
        const icon = fieldConfidenceIcon(field.value, field.confidence);
        console.log(
          `  ${fieldName.padEnd(14)} ${(field.value ?? "(null)").padEnd(20)}  confidence=${field.confidence.toFixed(2)}  ${icon}  reasons: ${field.reasons.join(", ") || "none"}`,
        );
      }

      const fallbackTriggered = shouldTriggerDrawingModelFallback({
        drawingSignals,
        hasDrawingFile: Boolean(titleBlockCropPath),
        modelEnabled: true,
      });
      console.log(`Model fallback triggered: ${fallbackTriggered ? "YES" : "NO"}`);
      if (drawingSignals.warnings.length > 0) {
        console.log(`  Warnings: ${drawingSignals.warnings.join("; ")}`);
      }
    }

    // Step 8: --parser-only skips model calls
    if (args.parserOnly) {
      continue;
    }

    // Step 10: Build image data URLs
    const { imageFileToDataUrl } = await import("./extractEvalProviders.js");

    let titleBlockCropDataUrl: string | null = null;
    if (titleBlockCropPath) {
      try {
        titleBlockCropDataUrl = await imageFileToDataUrl(titleBlockCropPath);
      } catch {
        titleBlockCropDataUrl = null;
      }
    }

    let fullPageDataUrl: string | null = null;
    if (fullPagePath) {
      try {
        fullPageDataUrl = await imageFileToDataUrl(fullPagePath);
      } catch {
        fullPageDataUrl = null;
      }
    }

    const parserContext = args.noParser
      ? null
      : serializeParserContext(drawingSignals);

    const evalInput: Omit<EvalModelInput, "attempt"> = {
      parserContext,
      baseName,
      titleBlockCropDataUrl,
      fullPageDataUrl,
    };

    // Step 11: Run all models in parallel
    const modelResultsSettled = await Promise.allSettled(
      args.models.map((modelId) =>
        runModel({
          modelId,
          providerOverride: args.providerOverride,
          apiKeys,
          evalInput,
          timeoutMs: args.timeoutMs,
        }),
      ),
    );

    const modelResults: Array<{
      modelId: string;
      output: EvalRunOutput;
      totalDurationMs: number;
    }> = modelResultsSettled.map((settled, i) => {
      const modelId = args.models[i]!;
      if (settled.status === "rejected") {
        const err = settled.reason;
        const errOutput: EvalErrorOutput = {
          modelName: modelId,
          errorType: "unknown",
          errorMessage: err instanceof Error ? err.message : String(err),
          durationMs: 0,
        };
        return { modelId, output: errOutput, totalDurationMs: 0 };
      }
      return { modelId, ...settled.value };
    });

    // Step 12: Render output
    if (args.json) {
      const jsonOutput = {
        pdfPath,
        baseName,
        parserOutput: Object.fromEntries(
          FIELD_NAMES.map((f) => [
            f,
            {
              value: drawingSignals[f].value,
              confidence: drawingSignals[f].confidence,
              reviewNeeded: drawingSignals[f].reviewNeeded,
              reasons: drawingSignals[f].reasons,
            },
          ]),
        ),
        models: modelResults.map(({ modelId, output, totalDurationMs }) => {
          if (isEvalError(output)) {
            return { modelId, error: output };
          }
          const fields = Object.fromEntries(
            FIELD_NAMES.map((f) => [
              f,
              {
                value: output.fields[f].value,
                confidence: output.fields[f].confidence,
                fieldSource: output.fields[f].fieldSource,
                reasons: output.fields[f].reasons,
                ...(groundTruth
                  ? { gt: gtIcon(output.fields[f].value, groundTruth.fields[f]) }
                  : {}),
              },
            ]),
          );
          return {
            modelId,
            fields,
            inputTokens: output.inputTokens,
            outputTokens: output.outputTokens,
            durationMs: totalDurationMs,
            estimatedCostUsd:
              output.estimatedCostUsd ??
              estimateCost(modelId, output.inputTokens, output.outputTokens)?.costUsd ??
              null,
          };
        }),
        groundTruth: groundTruth ?? null,
      };
      console.log(JSON.stringify(jsonOutput, null, 2));
    } else {
      console.log();
      console.log(renderAsciiTable(modelResults, groundTruth));
    }

    // Step 13: Save ground truth
    if (args.saveGroundTruth) {
      await saveGroundTruthFile({
        pdfPath,
        modelResults,
        isTty: Boolean(process.stdout.isTTY),
        jsonMode: args.json,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point guard
// ---------------------------------------------------------------------------

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
