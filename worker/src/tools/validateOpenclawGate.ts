import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadConfig } from "../config.js";
import { OPENCLAW_TARGET_VENDORS, evaluateOpenclawGate, type OpenclawGateVendor } from "../openclawGate.js";
import { createServiceClient } from "../queue.js";

type CliArgs = {
  quoteRunId: string;
  outPath: string | null;
  requiredVendors: OpenclawGateVendor[];
};

const USAGE =
  "Usage: npm --prefix worker run validate:openclaw-gate -- --quote-run-id <quote-run-id> [--required-vendors <xometry[,fictiv]>] [--out <output.json>]";
const KNOWN_FLAGS = new Set(["--quote-run-id", "--quoteRunId", "--required-vendors", "--out"]);

function parseRequiredVendors(rawValue: string): OpenclawGateVendor[] {
  if (rawValue.length === 0 || /\s/.test(rawValue)) {
    throw new Error(USAGE);
  }

  const rawVendors = rawValue.split(",");
  if (rawVendors.some((vendor) => vendor.length === 0)) {
    throw new Error(USAGE);
  }

  const uniqueVendors = Array.from(new Set(rawVendors.map((vendor) => vendor.toLowerCase())));
  const invalidVendor = uniqueVendors.find(
    (vendor) => !OPENCLAW_TARGET_VENDORS.includes(vendor as OpenclawGateVendor),
  );

  if (invalidVendor) {
    throw new Error(USAGE);
  }

  return uniqueVendors as OpenclawGateVendor[];
}

function parseFlagValue(arg: string, remainingArgs: string[]): string {
  const equalIndex = arg.indexOf("=");

  if (equalIndex >= 0) {
    const value = arg.slice(equalIndex + 1);
    if (value.length === 0) {
      throw new Error(USAGE);
    }

    return value;
  }

  const value = remainingArgs.shift();
  if (!value || value.startsWith("-")) {
    throw new Error(USAGE);
  }

  return value;
}

function parseArgs(argv = process.argv): CliArgs {
  const args = argv.slice(2);
  let quoteRunId: string | null = null;
  let outPath: string | null = null;
  let requiredVendors: OpenclawGateVendor[] = ["xometry"];

  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) {
      throw new Error(USAGE);
    }

    const flag = arg.split("=")[0];
    if (arg.startsWith("-") && !KNOWN_FLAGS.has(flag)) {
      throw new Error(USAGE);
    }

    if (flag === "--quote-run-id" || flag === "--quoteRunId") {
      quoteRunId = parseFlagValue(arg, args);
    } else if (flag === "--required-vendors") {
      requiredVendors = parseRequiredVendors(parseFlagValue(arg, args));
    } else if (flag === "--out") {
      outPath = path.resolve(parseFlagValue(arg, args));
    } else {
      throw new Error(USAGE);
    }
  }

  if (!quoteRunId || quoteRunId.trim().length === 0) {
    throw new Error(USAGE);
  }

  return {
    quoteRunId,
    outPath,
    requiredVendors,
  };
}

async function main() {
  const { quoteRunId, outPath, requiredVendors } = parseArgs();
  const config = loadConfig(process.env);
  const supabase = createServiceClient(config);
  const report = await evaluateOpenclawGate(supabase, quoteRunId, { requiredVendors });
  const serialized = JSON.stringify(report, null, 2);

  if (outPath) {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, serialized, "utf8");
  }

  console.log(serialized);

  if (report.decision === "pass") {
    process.exitCode = 0;
    return;
  }

  process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 2;
}
