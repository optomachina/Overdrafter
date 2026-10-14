import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
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

/** Directories whose approved files carry no customer data. */
export const OPERATOR_FIXTURE_ROOTS: readonly string[] = Object.freeze([
  path.join(REPO_ROOT, "worker", "eval-corpus"),
  path.join(REPO_ROOT, "worker", "test-support"),
  path.join(REPO_ROOT, "e2e", "fixtures"),
]);

/**
 * Approved fixture drawings: repo relative POSIX path to the SHA-256 of the
 * reviewed bytes. A file in a fixture root is admitted only when its path and
 * hash both appear here, so an untracked or replaced drawing is not a fixture.
 * Add an entry in the same change that adds a rights approved drawing.
 */
export const OPERATOR_FIXTURE_MANIFEST: Readonly<Record<string, string>> = Object.freeze({});

const SHA256_HEX = /^[0-9a-f]{64}$/;

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

async function sha256OfFile(filePath: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

/**
 * True when the file resolves, symlinks followed, to a path under a fixture
 * root, and its repo relative path and current SHA-256 match an approved
 * manifest entry. A missing, untracked, or modified file is not a fixture.
 * `contentSha256` is the hash of bytes already staged by the caller; it is used
 * instead of rereading the path, so the check covers the bytes that get sent.
 */
export async function isInRepoFixture(
  filePath: string,
  roots: readonly string[] = OPERATOR_FIXTURE_ROOTS,
  manifest: Readonly<Record<string, string>> = OPERATOR_FIXTURE_MANIFEST,
  repoRoot: string = REPO_ROOT,
  contentSha256?: string,
): Promise<boolean> {
  let resolved: string;
  try {
    resolved = await fs.realpath(filePath);
  } catch {
    return false;
  }
  let inRoot = false;
  for (const root of roots) {
    const realRoot = await fs.realpath(root).catch(() => null);
    if (realRoot && isInside(realRoot, resolved)) {
      inRoot = true;
      break;
    }
  }
  if (!inRoot) return false;

  const realRepo = await fs.realpath(repoRoot).catch(() => null);
  if (!realRepo || !isInside(realRepo, resolved)) return false;
  const key = path.relative(realRepo, resolved).split(path.sep).join("/");
  const approved = Object.hasOwn(manifest, key) ? manifest[key] : undefined;
  if (typeof approved !== "string" || !SHA256_HEX.test(approved)) return false;
  try {
    return (contentSha256 ?? (await sha256OfFile(resolved))) === approved;
  } catch {
    return false;
  }
}

/**
 * Throws unless the staged bytes hash to a drawing record of this job. This
 * binds the job's export declaration to the file the operator is about to send.
 */
async function assertFileBelongsToJob(
  client: Pick<SupabaseClient, "from">,
  input: { filePath: string; jobId: string; localHash: string },
): Promise<void> {
  const fail = (reason: string) =>
    new OperatorExportGateError(`Refusing ${input.filePath}: ${reason}`);
  const { localHash } = input;
  let rows: unknown;
  try {
    const { data, error } = await client
      .from("job_files")
      .select("content_sha256")
      .eq("job_id", input.jobId)
      .eq("file_kind", "drawing");
    if (error) throw fail("the job drawing lookup failed.");
    rows = data;
  } catch (error) {
    if (error instanceof OperatorExportGateError) throw error;
    throw fail("the job drawing lookup failed.");
  }
  const hashes = Array.isArray(rows)
    ? rows.map((row) => (row as { content_sha256?: unknown })?.content_sha256)
    : [];
  if (!hashes.some((hash) => typeof hash === "string" && hash.toLowerCase() === localHash)) {
    throw fail(`the file does not match any drawing recorded for job ${input.jobId}.`);
  }
}

export type OperatorExportGate<T extends DrawingTextForExportScan = DrawingTextForExportScan> = {
  /** Runs before each model attempt; a no-op for a fixture. */
  beforeModelAttempt: () => Promise<void>;
  basis: "fixture" | "job_declaration";
  /** Private copy of the admitted bytes. Render and send this, never the original path. */
  drawingPath: string;
  /** Text read from the snapshot, as scanned by the gate. */
  pdfText: T | null;
  /** Removes the snapshot. Call once the run is finished. */
  cleanup: () => Promise<void>;
};

/**
 * Admits one drawing for model extraction or throws `OperatorExportGateError`.
 * The file is copied into a private directory first; the text read, the hash,
 * the job match, and every later render or model attempt use that snapshot, so
 * replacing the original after admission changes nothing that is sent.
 * An approved fixture (path and hash in the manifest) passes. Anything else
 * needs `jobId`, a fully read drawing with no marking whose bytes match one of
 * that job's drawing records, and a clean declaration from `api_check_export_control_extraction`.
 */
export async function admitOperatorDrawing<T extends DrawingTextForExportScan>(input: {
  filePath: string;
  jobId: string | null;
  readPdfText: (snapshotPath: string) => Promise<T | null>;
  supabase: () => Pick<SupabaseClient, "rpc" | "from">;
  isFixture?: (filePath: string, contentSha256: string) => Promise<boolean>;
}): Promise<OperatorExportGate<T>> {
  const snapshotDir = await fs.mkdtemp(path.join(os.tmpdir(), "overdrafter-operator-drawing-"));
  const cleanup = () => fs.rm(snapshotDir, { recursive: true, force: true });
  try {
    const snapshotPath = path.join(snapshotDir, path.basename(input.filePath));
    let localHash: string;
    try {
      await fs.copyFile(input.filePath, snapshotPath);
      await fs.chmod(snapshotPath, 0o600);
      localHash = await sha256OfFile(snapshotPath);
    } catch {
      throw new OperatorExportGateError(`Refusing ${input.filePath}: the file could not be read to stage it.`);
    }
    const base = { drawingPath: snapshotPath, cleanup };

    const isFixture =
      input.isFixture ??
      ((file: string, hash: string) => isInRepoFixture(file, OPERATOR_FIXTURE_ROOTS, OPERATOR_FIXTURE_MANIFEST, REPO_ROOT, hash));
    const pdfText = await input.readPdfText(snapshotPath);
    if (await isFixture(input.filePath, localHash)) {
      return { ...base, pdfText, basis: "fixture", beforeModelAttempt: async () => undefined };
    }

    if (!input.jobId) {
      throw new OperatorExportGateError(
        `Refusing ${input.filePath}: it is not an in-repo fixture. Pass --job-id for a job whose export declaration is clean.`,
      );
    }

    const hit = scanDrawingTextForExportMarkings(pdfText);
    if (hit) {
      throw new OperatorExportGateError(
        `Refusing ${input.filePath}: export control markings found (${hit.patterns.join(", ")}).`,
      );
    }
    if (!isDrawingTextFullyRead(pdfText)) {
      throw new OperatorExportGateError(
        `Refusing ${input.filePath}: not every drawing page could be read, so the marking scan is incomplete.`,
      );
    }

    const client = input.supabase();
    await assertFileBelongsToJob(client, { filePath: input.filePath, jobId: input.jobId, localHash });
    try {
      await assertExportControlExtractionAllowed(client, { jobId: input.jobId });
    } catch (error) {
      throw new OperatorExportGateError(
        `Refusing ${input.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return {
      ...base,
      pdfText,
      basis: "job_declaration",
      beforeModelAttempt: exportControlModelAttemptGuard(client, { jobId: input.jobId }),
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Reads `--job-id <id>` from argv. */
export function readJobIdArg(argv: readonly string[]): string | null {
  const index = argv.indexOf("--job-id");
  const value = index === -1 ? undefined : argv[index + 1]?.trim();
  return value ? value : null;
}

