import "dotenv/config";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { XometryAdapter } from "../adapters/xometry.js";
import type { VendorQuoteAdapterInput, WorkerConfig } from "../types.js";

const DEFAULT_QUANTITIES = [1, 5, 25, 100];

type SweepRow = {
  quantity: number;
  startedAt: string;
  elapsedSec: number;
  status: string | null;
  totalPriceUsd: number | null;
  unitPriceUsd: number | null;
  leadTimeBusinessDays: number | null;
  quoteUrl: string | null;
  parsedOptions: Array<{ days: number; priceUsd: number }>;
  bodyExcerpt: string | null;
  error: string | null;
};

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}

function parseQuantitiesArg(): number[] {
  const flagIndex = process.argv.indexOf("--quantities");
  if (flagIndex < 0) return DEFAULT_QUANTITIES;
  const raw = process.argv[flagIndex + 1];
  if (!raw) return DEFAULT_QUANTITIES;
  const parsed = raw
    .split(",")
    .map((token) => Number.parseInt(token.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
  return parsed.length > 0 ? parsed : DEFAULT_QUANTITIES;
}

function makeConfig(): WorkerConfig {
  return {
    supabaseUrl: "https://example.supabase.co",
    supabaseServiceRoleKey: "service-role-key",
    workerMode: "live",
    workerLiveAdapters: ["xometry"],
    workerName: "xometry-sweep",
    pollIntervalMs: 5000,
    httpHost: "127.0.0.1",
    httpPort: 0,
    workerTempDir: path.join(os.tmpdir(), "overdrafter-xometry-sweep"),
    artifactBucket: "quote-artifacts",
    playwrightHeadless: process.env.PLAYWRIGHT_HEADLESS !== "false",
    playwrightCaptureTrace: false,
    browserTimeoutMs: 90_000,
    playwrightDisableSandbox: false,
    playwrightDisableDevShmUsage: true,
    xometryStorageStatePath: requiredEnv("XOMETRY_STORAGE_STATE_PATH"),
    xometryStorageStateJson: process.env.XOMETRY_STORAGE_STATE_JSON ?? null,
    xometryUserDataDir: process.env.XOMETRY_USER_DATA_DIR ?? null,
    xometryBrowserChannel: process.env.XOMETRY_BROWSER_CHANNEL ?? null,
    xometryProfileLockWaitMs: 30_000,
    xometrySessionFreshnessWarnDays: 14,
    fictivStorageStatePath: null,
    fictivStorageStateJson: null,
    openAiApiKey: null,
    anthropicApiKey: null,
    openRouterApiKey: null,
    workerBuildVersion: "dev-sweep",
    drawingExtractionModel: "gpt-5.4",
    drawingExtractionEnableModelFallback: false,
    drawingExtractionDebugAllowedModels: ["gpt-5.4"],
  };
}

function makeInput(quantity: number, cadPath: string, drawingPath: string | null): VendorQuoteAdapterInput {
  const stamp = Date.now();
  return {
    organizationId: "org-sweep",
    quoteRunId: `xometry-sweep-${stamp}-q${quantity}`,
    requestedQuantity: quantity,
    part: {
      id: `part-sweep-${stamp}-q${quantity}`,
      job_id: "job-sweep",
      organization_id: "org-sweep",
      name: "Quantity Sweep Part",
      normalized_key: `quantity-sweep-q${quantity}`,
      cad_file_id: "cad-sweep",
      drawing_file_id: drawingPath ? "drawing-sweep" : null,
      quantity,
    },
    cadFile: {
      id: "cad-sweep",
      job_id: "job-sweep",
      storage_bucket: "job-files",
      storage_path: "cad/sweep.step",
      original_name: path.basename(cadPath),
      file_kind: "cad",
    },
    drawingFile: drawingPath
      ? {
          id: "drawing-sweep",
          job_id: "job-sweep",
          storage_bucket: "job-files",
          storage_path: "drawing/sweep.pdf",
          original_name: path.basename(drawingPath),
          file_kind: "drawing",
        }
      : null,
    stagedCadFile: {
      originalName: path.basename(cadPath),
      localPath: cadPath,
      storageBucket: "job-files",
      storagePath: "cad/sweep.step",
    },
    stagedDrawingFile: drawingPath
      ? {
          originalName: path.basename(drawingPath),
          localPath: drawingPath,
          storageBucket: "job-files",
          storagePath: "drawing/sweep.pdf",
        }
      : null,
    requirement: {
      id: `req-sweep-q${quantity}`,
      part_id: `part-sweep-q${quantity}`,
      description: `Quantity sweep test, qty ${quantity}`,
      part_number: "SWEEP-001",
      revision: "A",
      material: "6061 aluminum",
      finish: "as machined",
      tightest_tolerance_inch: 0.005,
      quantity,
      quote_quantities: [quantity],
      requested_by_date: null,
      applicable_vendors: ["xometry"],
    },
  };
}

const OPTION_PATTERN =
  /(\d{1,3})\s+(?:(?:production|business|working|calendar)\s+)?days?[^$]{0,80}?\$([\d,]+\.\d{2})/gi;

function parseLeadTimeOptions(text: string) {
  const seen = new Set<string>();
  const options: Array<{ days: number; priceUsd: number }> = [];
  for (const match of text.matchAll(OPTION_PATTERN)) {
    const days = Number.parseInt(match[1], 10);
    const price = Number.parseFloat(match[2].replaceAll(",", ""));
    if (!Number.isFinite(days) || !Number.isFinite(price)) continue;
    const key = `${days}:${price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ days, priceUsd: price });
  }
  return options.sort((a, b) => a.days - b.days || a.priceUsd - b.priceUsd);
}

function rawPayloadBodyExcerpt(rawPayload: unknown): string {
  if (!rawPayload || typeof rawPayload !== "object") return "";
  const record = rawPayload as Record<string, unknown>;
  const excerpt = record.bodyExcerpt;
  return typeof excerpt === "string" ? excerpt : "";
}

function formatPrice(value: number | null): string {
  return value === null ? "—" : `$${value.toFixed(2)}`;
}

function formatBusinessDays(value: number | null): string {
  return value === null ? "—" : `${value} days`;
}

function formatRow(row: SweepRow) {
  if (row.error) {
    return `  qty ${row.quantity}: ERROR (${row.elapsedSec.toFixed(1)}s) — ${row.error}`;
  }
  const total = formatPrice(row.totalPriceUsd);
  const unit = formatPrice(row.unitPriceUsd);
  const lead = formatBusinessDays(row.leadTimeBusinessDays);
  return `  qty ${row.quantity}: ${row.status} | total ${total} | unit ${unit} | lead ${lead} | ${row.elapsedSec.toFixed(1)}s | ${row.parsedOptions.length} options scraped`;
}

function buildErrorRow(quantity: number, startedAt: string, startMs: number, error: unknown): SweepRow {
  const message = error instanceof Error ? error.message : String(error);
  return {
    quantity,
    startedAt,
    elapsedSec: (Date.now() - startMs) / 1000,
    status: null,
    totalPriceUsd: null,
    unitPriceUsd: null,
    leadTimeBusinessDays: null,
    quoteUrl: null,
    parsedOptions: [],
    bodyExcerpt: null,
    error: message,
  };
}

async function runQuote(
  adapter: XometryAdapter,
  quantity: number,
  cadPath: string,
  drawingPath: string | null,
): Promise<SweepRow> {
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  process.stdout.write(`\n>>> Quoting qty ${quantity}... `);

  try {
    const result = await adapter.quote(makeInput(quantity, cadPath, drawingPath));
    const bodyExcerpt = rawPayloadBodyExcerpt(result.rawPayload);
    console.log("done");
    return {
      quantity,
      startedAt,
      elapsedSec: (Date.now() - startMs) / 1000,
      status: result.status,
      totalPriceUsd: result.totalPriceUsd,
      unitPriceUsd: result.unitPriceUsd,
      leadTimeBusinessDays: result.leadTimeBusinessDays,
      quoteUrl: result.quoteUrl,
      parsedOptions: parseLeadTimeOptions(bodyExcerpt),
      bodyExcerpt,
      error: null,
    };
  } catch (error) {
    console.log("FAILED");
    return buildErrorRow(quantity, startedAt, startMs, error);
  }
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

function printOptionsBreakdown(rows: SweepRow[]) {
  console.log("\n=== Full lead-time options per quantity (parsed from page text) ===\n");
  for (const row of rows) {
    if (row.parsedOptions.length === 0) {
      console.log(`qty ${row.quantity}: (no options parsed)`);
      continue;
    }
    console.log(`qty ${row.quantity}:`);
    for (const option of row.parsedOptions) {
      const unitPrice = option.priceUsd / row.quantity;
      console.log(`  - ${String(option.days).padStart(3)} days  $${option.priceUsd.toFixed(2).padStart(9)} total  ($${unitPrice.toFixed(2)}/unit)`);
    }
  }
}

async function main() {
  const cadPath = requiredEnv("XOMETRY_LIVE_TEST_CAD_PATH");
  const drawingPath = process.env.XOMETRY_LIVE_TEST_DRAWING_PATH ?? null;
  const quantities = parseQuantitiesArg();

  console.log(`Xometry pricing sweep — quantities: [${quantities.join(", ")}]`);
  console.log(`  CAD: ${cadPath}`);
  console.log(`  Drawing: ${drawingPath ?? "(none)"}`);

  const adapter = new XometryAdapter("xometry", makeConfig());
  const rows: SweepRow[] = [];

  for (const quantity of quantities) {
    const row = await runQuote(adapter, quantity, cadPath, drawingPath);
    rows.push(row);
    console.log(formatRow(row));
  }

  printPricingCurve(rows);
  printOptionsBreakdown(rows);

  const outPath = path.join(os.tmpdir(), `xometry-sweep-${Date.now()}.json`);
  await fs.writeFile(outPath, JSON.stringify(rows, null, 2), "utf8");
  console.log(`\nFull results written to: ${outPath}`);
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
