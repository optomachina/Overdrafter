import "dotenv/config";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { hasNonExportControlledConfirmation } from "../liveEvaluationFiles.js";
import { runEvaluationBatch } from "./vendorWorkflowSmoke.js";

const DEFAULT_QUANTITIES = [1, 5, 25, 100];

type StructuredOption = {
  region: string;
  tier: string;
  days: number | null;
  totalPriceUsd: number | null;
  unitPriceUsd: number | null;
  rawText?: string;
};

type SweepRow = {
  quantity: number;
  startedAt: string;
  elapsedSec: number;
  status: string | null;
  totalPriceUsd: number | null;
  unitPriceUsd: number | null;
  leadTimeBusinessDays: number | null;
  quoteUrl: string | null;
  structuredOptions: StructuredOption[];
  bodyExcerpt: string | null;
  error: string | null;
};

function requiredEnv(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}

function parseQuantitiesArg(argv: string[]): number[] {
  const flagIndex = argv.indexOf("--quantities");
  if (flagIndex < 0) return DEFAULT_QUANTITIES;
  const raw = argv[flagIndex + 1];
  if (!raw) return DEFAULT_QUANTITIES;
  const parsed = raw
    .split(",")
    .map((token) => Number.parseInt(token.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
  return parsed.length > 0 ? parsed : DEFAULT_QUANTITIES;
}

function rawPayloadBodyExcerpt(rawPayload: unknown): string {
  if (!rawPayload || typeof rawPayload !== "object") return "";
  const record = rawPayload as Record<string, unknown>;
  const excerpt = record.bodyExcerpt;
  return typeof excerpt === "string" ? excerpt : "";
}

function rawPayloadLeadTimeOptions(rawPayload: unknown, quantity: number): StructuredOption[] {
  if (!rawPayload || typeof rawPayload !== "object") return [];
  const record = rawPayload as Record<string, unknown>;
  const options = record.leadTimeOptions;
  if (!Array.isArray(options)) return [];
  return options
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    .map((entry) => {
      const region = typeof entry.region === "string" ? entry.region : "unknown";
      const tier = typeof entry.tier === "string" ? entry.tier : "unknown";
      const days = typeof entry.days === "number" ? entry.days : null;
      const totalPriceUsd = typeof entry.totalPriceUsd === "number" ? entry.totalPriceUsd : null;
      const rawText = typeof entry.rawText === "string" ? entry.rawText : undefined;
      const unitPriceUsd =
        totalPriceUsd !== null && quantity > 0
          ? Math.round((totalPriceUsd / quantity) * 100) / 100
          : null;
      return { region, tier, days, totalPriceUsd, unitPriceUsd, rawText };
    })
    .sort((a, b) => {
      if (a.region !== b.region) return a.region.localeCompare(b.region);
      const tierOrder = ["fastest", "standard", "cost_effective"];
      return tierOrder.indexOf(a.tier) - tierOrder.indexOf(b.tier);
    });
}

function formatPrice(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(2)}`;
}

function formatBusinessDays(value: number | null): string {
  return value === null ? "—" : `${value} days`;
}

function formatDaysSuffix(value: number | null): string {
  return value === null ? "—" : `${value}d`;
}

function formatRow(row: SweepRow) {
  if (row.error) {
    return `  qty ${row.quantity}: ERROR (${row.elapsedSec.toFixed(1)}s) — ${row.error}`;
  }
  const total = formatPrice(row.totalPriceUsd);
  const unit = formatPrice(row.unitPriceUsd);
  const lead = formatBusinessDays(row.leadTimeBusinessDays);
  return `  qty ${row.quantity}: ${row.status} | total ${total} | unit ${unit} | lead ${lead} | ${row.elapsedSec.toFixed(1)}s | ${row.structuredOptions.length} options scraped`;
}

function printPricingCurve(rows: SweepRow[]) {
  console.log("\n=== Pricing curve (selected option per run) ===\n");
  console.log("| Qty | Status                  | Lead time | Total      | Unit price |");
  console.log("|-----|-------------------------|-----------|------------|------------|");
  for (const row of rows) {
    if (row.error) {
      console.log(`| ${String(row.quantity).padStart(3)} | error                   | —         | —          | —          |`);
      continue;
    }
    const total = formatPrice(row.totalPriceUsd);
    const unit = formatPrice(row.unitPriceUsd);
    const lead = formatBusinessDays(row.leadTimeBusinessDays);
    console.log(`| ${String(row.quantity).padStart(3)} | ${(row.status ?? "—").padEnd(23)} | ${lead.padEnd(9)} | ${total.padEnd(10)} | ${unit.padEnd(10)} |`);
  }
}

function printStructuredGrid(rows: SweepRow[]) {
  console.log("\n=== Structured lead-time grid (region × tier × quantity) ===\n");
  console.log("| Qty | Region   | Tier            | Days  | Total       | Unit price |");
  console.log("|-----|----------|-----------------|-------|-------------|------------|");
  for (const row of rows) {
    if (row.structuredOptions.length === 0) {
      console.log(`| ${String(row.quantity).padStart(3)} | (no structured options captured)                                  |`);
      continue;
    }
    for (const option of row.structuredOptions) {
      const days = formatDaysSuffix(option.days);
      const total = formatPrice(option.totalPriceUsd);
      const unit = formatPrice(option.unitPriceUsd);
      console.log(`| ${String(row.quantity).padStart(3)} | ${option.region.padEnd(8)} | ${option.tier.padEnd(15)} | ${days.padEnd(5)} | ${total.padEnd(11)} | ${unit.padEnd(10)} |`);
    }
  }
}

type FictivSweepDependencies = {
  runBatch?: typeof runEvaluationBatch;
};

export async function runFictivQuantitySweep(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  dependencies: FictivSweepDependencies = {},
): Promise<SweepRow[]> {
  const cadPath = path.resolve(requiredEnv(env, "FICTIV_LIVE_TEST_CAD_PATH"));
  const drawingPathValue = env.FICTIV_LIVE_TEST_DRAWING_PATH ?? null;
  const drawingPath = drawingPathValue ? path.resolve(drawingPathValue) : null;
  const quantities = parseQuantitiesArg(argv);
  const confirmedNonExportControlled = hasNonExportControlledConfirmation(argv, env);

  if (!confirmedNonExportControlled) {
    throw new Error(
      "Fictiv quantity evaluation requires --confirm-non-export-controlled or QUOTE_VENDOR_LIVE_EVALUATION_NON_EXPORT_CONTROLLED=true.",
    );
  }

  console.log(`Fictiv pricing sweep — quantities: [${quantities.join(", ")}]`);
  console.log(`  CAD: ${cadPath}`);
  console.log(`  Drawing: ${drawingPath ?? "(none)"}`);

  const evaluationRows = await (dependencies.runBatch ?? runEvaluationBatch)({
    vendors: ["fictiv"],
    cadPath,
    drawingPath,
    quantities,
    confirmedNonExportControlled,
  });
  const rows = evaluationRows.map<SweepRow>((row) => {
    const error = [row.error, row.cleanupError].filter(Boolean).join("; ") || null;
    return {
      quantity: row.quantity,
      startedAt: row.startedAt,
      elapsedSec: row.elapsedSec,
      status: row.status,
      totalPriceUsd: row.totalPriceUsd,
      unitPriceUsd: row.unitPriceUsd,
      leadTimeBusinessDays: row.leadTimeBusinessDays,
      quoteUrl: row.quoteUrl,
      structuredOptions: rawPayloadLeadTimeOptions(row.rawPayload, row.quantity),
      bodyExcerpt: rawPayloadBodyExcerpt(row.rawPayload),
      error,
    };
  });

  for (const row of rows) {
    console.log(formatRow(row));
  }

  printPricingCurve(rows);
  printStructuredGrid(rows);

  const outPath = path.join(os.tmpdir(), `fictiv-sweep-${Date.now()}.json`);
  await fs.writeFile(outPath, JSON.stringify(rows, null, 2), "utf8");
  console.log(`\nFull results written to: ${outPath}`);
  return rows;
}

const invokedAsScript = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (invokedAsScript) {
  try {
    await runFictivQuantitySweep();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
