/**
 * Operator step for a hosted Xometry auth probe that ended in
 * `authenticated_dashboard_not_confirmed`: turn the job's fingerprint log line
 * into the finite drift result selector repair starts from. Offline only; it
 * reads a file and never contacts Xometry or any cloud API.
 *
 *   npx tsx src/tools/xometryDriftResult.ts <logs.json|-> [--baseline <fingerprint.json>]
 *
 * <logs.json> is `gcloud logging read ... --format=json` output for the one
 * execution. See docs/provider-integration.md §"Selector repair".
 */
import fs from "node:fs/promises";
import process from "node:process";
import { buildDriftResult, readFingerprintLogEntries } from "../fixtureHeal/driftResult.js";
import { FingerprintVocabularyMismatchError, parsePageFingerprint } from "../fixtureHeal/fingerprint.js";
import { XOMETRY_AUTH_PROBE_DRIFT_REFERENCE } from "../xometryAuthProbe.js";

const USAGE = "usage: xometryDriftResult <logs.json|-> [--baseline <fingerprint.json>]";

async function readInput(path: string) {
  if (path !== "-") return fs.readFile(path, "utf8");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function main(args: string[]) {
  const [logsPath, flag, baselinePath, ...rest] = args;
  if (!logsPath || rest.length > 0 || (flag !== undefined && (flag !== "--baseline" || !baselinePath))) {
    throw new Error(USAGE);
  }
  const reference = XOMETRY_AUTH_PROBE_DRIFT_REFERENCE;
  const { trigger, fingerprint } = readFingerprintLogEntries(JSON.parse(await readInput(logsPath)), reference.vocabulary);
  let baseline = null;
  if (baselinePath) {
    // Checked after the log line, so a digest mismatch here means a stale baseline, not the wrong checkout.
    baseline = parsePageFingerprint(JSON.parse(await fs.readFile(baselinePath, "utf8")), reference.vocabulary, "baseline");
    if (!baseline) throw new Error("drift_baseline_invalid");
  }
  return buildDriftResult({ trigger, fingerprint, baseline, reference });
}

try {
  console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2));
} catch (error) {
  // Only fixed messages or the typed, hex-only vocabulary diagnostic: JSON errors can quote input.
  const message = error instanceof Error ? error.message : "";
  console.error(error instanceof FingerprintVocabularyMismatchError || /^drift_[a-z_]+$/.test(message) || message === USAGE ? message : "drift_input_invalid");
  process.exit(1);
}
