import "dotenv/config";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { XometryAdapter } from "../adapters/xometry.js";
import type { VendorQuoteAdapterInput, WorkerConfig } from "../types.js";
import { buildVendorQuoteFilePayload } from "./_vendorQuoteInputBuilders.js";

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
    xometryBrowserEngine: process.env.XOMETRY_BROWSER_ENGINE === "camoufox" ? "camoufox" : "patchright",
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
    ...buildVendorQuoteFilePayload({
      cadPath,
      drawingPath,
      idPrefix: "sweep",
    }),
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

// `[^$]*` is intentionally greedy with a negated character class — since
// `[^$]` cannot match `$`, no backtracking is required to find the next `\$`.
// (SonarCloud S5852 flagged the previous lazy form `[^$]{0,80}?` as a regex
// DOS risk via super-linear backtracking. The greedy form is linear-time.)
const OPTION_PATTERN = /(\d{1,3})\s+(?:production|business|working|calendar)?\s*days?[^$]*\$([\d,]+\.\d{2})/gi;

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

function formatRow(row: SweepRow) {
  if (row.error) {
    return `  qty ${row.quantity}: ERROR (${row.elapsedSec.toFixed(1)}s) — ${row.error}`;
  }
  const total = row.totalPriceUsd !== null ? `$${row.totalPriceUsd.toFixed(2)}` : "—";
  const unit = row.unitPriceUsd !== null ? `$${row.unitPriceUsd.toFixed(2)}` : "—";
  const lead = row.leadTimeBusinessDays !== null ? `${row.leadTimeBusinessDays} days` : "—";
  return `  qty ${row.quantity}: ${row.status} | total ${total} | unit ${unit} | lead ${lead} | ${row.elapsedSec.toFixed(1)}s | ${row.parsedOptions.length} options scraped`;
}

async function main() {
  const cadPath = requiredEnv("XOMETRY_LIVE_TEST_CAD_PATH");
  const drawingPath = process.env.XOMETRY_LIVE_TEST_DRAWING_PATH ?? null;
  const quantities = parseQuantitiesArg();

  console.log(`Xometry pricing sweep — quantities: [${quantities.join(", ")}]`);
  console.log(`  CAD: ${cadPath}`);
  console.log(`  Drawing: ${drawingPath ?? "(none)"}`);

  const config = makeConfig();
  const adapter = new XometryAdapter("xometry", config);
  const rows: SweepRow[] = [];

  for (const quantity of quantities) {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    process.stdout.write(`\n>>> Quoting qty ${quantity}... `);

    let row: SweepRow;
    try {
      const result = await adapter.quote(makeInput(quantity, cadPath, drawingPath));
      const elapsedSec = (Date.now() - startMs) / 1000;
      const bodyExcerpt = rawPayloadBodyExcerpt(result.rawPayload);
      const parsedOptions = parseLeadTimeOptions(bodyExcerpt);

      row = {
        quantity,
        startedAt,
        elapsedSec,
        status: result.status,
        totalPriceUsd: result.totalPriceUsd,
        unitPriceUsd: result.unitPriceUsd,
        leadTimeBusinessDays: result.leadTimeBusinessDays,
        quoteUrl: result.quoteUrl,
        parsedOptions,
        bodyExcerpt,
        error: null,
      };
      console.log("done");
    } catch (error) {
      const elapsedSec = (Date.now() - startMs) / 1000;
      const message = error instanceof Error ? error.message : String(error);
      row = {
        quantity,
        startedAt,
        elapsedSec,
        status: null,
        totalPriceUsd: null,
        unitPriceUsd: null,
        leadTimeBusinessDays: null,
        quoteUrl: null,
        parsedOptions: [],
        bodyExcerpt: null,
        error: message,
      };
      console.log("FAILED");
    }

    rows.push(row);
    console.log(formatRow(row));
  }

  console.log("\n=== Pricing curve (selected option per run) ===\n");
  console.log("| Qty | Status                  | Lead time | Total      | Unit price |");
  console.log("|-----|-------------------------|-----------|------------|------------|");
  for (const row of rows) {
    if (row.error) {
      console.log(`| ${String(row.quantity).padStart(3)} | error                   | —         | —          | —          |`);
      continue;
    }
    const total = row.totalPriceUsd !== null ? `$${row.totalPriceUsd.toFixed(2)}` : "—";
    const unit = row.unitPriceUsd !== null ? `$${row.unitPriceUsd.toFixed(2)}` : "—";
    const lead = row.leadTimeBusinessDays !== null ? `${row.leadTimeBusinessDays} days` : "—";
    console.log(`| ${String(row.quantity).padStart(3)} | ${(row.status ?? "—").padEnd(23)} | ${lead.padEnd(9)} | ${total.padEnd(10)} | ${unit.padEnd(10)} |`);
  }

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

  const outPath = path.join(os.tmpdir(), `xometry-sweep-${Date.now()}.json`);
  await fs.writeFile(outPath, JSON.stringify(rows, null, 2), "utf8");
  console.log(`\nFull results written to: ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
