import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assertExportControlExtractionAllowed,
  exportControlModelAttemptGuard,
  isDrawingTextFullyRead,
  scanDrawingTextForExportMarkings,
  type DrawingTextForExportScan,
} from "../exportControl.js";

/**
 * OVD-757: export-control gate for operator tools that send drawing content to
 * an extraction model. It reuses the OVD-723 worker helpers, so an operator
 * run passes the same checks as the dispatch and extraction path: every page
 * read, no marking hit, and a job whose latest declaration is clean with no
 * open block. Unlike the worker, it never writes a block or scan record.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Directories whose files are checked in and carry no customer data. */
export const OPERATOR_FIXTURE_ROOTS: readonly string[] = Object.freeze([
  path.join(REPO_ROOT, "worker", "eval-corpus"),
  path.join(REPO_ROOT, "worker", "test-support"),
  path.join(REPO_ROOT, "e2e", "fixtures"),
]);

export class OperatorExportGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperatorExportGateError";
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * True when the file resolves, symlinks followed, to a path under an in-repo
 * fixture root. A missing file is not a fixture.
 */
export async function isInRepoFixture(
  filePath: string,
  roots: readonly string[] = OPERATOR_FIXTURE_ROOTS,
): Promise<boolean> {
  let resolved: string;
  try {
    resolved = await fs.realpath(filePath);
  } catch {
    return false;
  }
  for (const root of roots) {
    const realRoot = await fs.realpath(root).catch(() => null);
    if (realRoot && isInside(realRoot, resolved)) return true;
  }
  return false;
}

export type OperatorExportGate = {
  /** Runs before each model attempt; a no-op for a fixture. */
  beforeModelAttempt: () => Promise<void>;
  basis: "fixture" | "job_declaration";
};

/**
 * Admits one drawing for model extraction or throws `OperatorExportGateError`.
 * A fixture passes. Anything else needs `jobId`, a fully read drawing with no
 * marking, and a clean declaration from `api_check_export_control_extraction`.
 */
export async function admitOperatorDrawing(input: {
  filePath: string;
  jobId: string | null;
  pdfText: DrawingTextForExportScan | null;
  supabase: () => Pick<SupabaseClient, "rpc">;
  isFixture?: (filePath: string) => Promise<boolean>;
}): Promise<OperatorExportGate> {
  if (await (input.isFixture ?? isInRepoFixture)(input.filePath)) {
    return { basis: "fixture", beforeModelAttempt: async () => undefined };
  }

  if (!input.jobId) {
    throw new OperatorExportGateError(
      `Refusing ${input.filePath}: it is not an in-repo fixture. Pass --job-id for a job whose export declaration is clean.`,
    );
  }

  const hit = scanDrawingTextForExportMarkings(input.pdfText);
  if (hit) {
    throw new OperatorExportGateError(
      `Refusing ${input.filePath}: export control markings found (${hit.patterns.join(", ")}).`,
    );
  }
  if (!isDrawingTextFullyRead(input.pdfText)) {
    throw new OperatorExportGateError(
      `Refusing ${input.filePath}: not every drawing page could be read, so the marking scan is incomplete.`,
    );
  }

  const client = input.supabase();
  try {
    await assertExportControlExtractionAllowed(client, { jobId: input.jobId });
  } catch (error) {
    throw new OperatorExportGateError(
      `Refusing ${input.filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { basis: "job_declaration", beforeModelAttempt: exportControlModelAttemptGuard(client, { jobId: input.jobId }) };
}

/** Reads `--job-id <id>` from argv. */
export function readJobIdArg(argv: readonly string[]): string | null {
  const index = argv.indexOf("--job-id");
  const value = index === -1 ? undefined : argv[index + 1]?.trim();
  return value ? value : null;
}

