import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { loadConfig } from "../config.js";
import { evaluateOpenclawGate } from "../openclawGate.js";
import { createServiceClient } from "../queue.js";

type CliArgs = {
  quoteRunId: string;
  outPath: string | null;
};

function parseArgs(argv = process.argv): CliArgs {
  const args = argv.slice(2);
  let quoteRunId: string | null = null;
  let outPath: string | null = null;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--quote-run-id" || arg === "--quoteRunId") {
      quoteRunId = args[i + 1] ?? null;
      i += 1;
    } else if (arg === "--out") {
      const outArg = args[i + 1];
      if (!outArg || outArg.startsWith("-")) {
        throw new Error(
          "Usage: npm --prefix worker run validate:openclaw-gate -- --quote-run-id <quote-run-id> [--out <output.json>]",
        );
      }
      outPath = path.resolve(outArg);
      i += 1;
    }
  }

  if (!quoteRunId || quoteRunId.trim().length === 0) {
    throw new Error(
      "Usage: npm --prefix worker run validate:openclaw-gate -- --quote-run-id <quote-run-id> [--out <output.json>]",
    );
  }

  return {
    quoteRunId,
    outPath,
  };
}

async function main() {
  const { quoteRunId, outPath } = parseArgs();
  const config = loadConfig(process.env);
  const supabase = createServiceClient(config);
  const report = await evaluateOpenclawGate(supabase, quoteRunId);
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
