import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  LiveEvaluationAuthorization,
  LiveEvaluationUploadFile,
  LiveEvaluationUploadFiles,
  VendorQuoteAdapterInput,
} from "./types.js";

const CONFIRMATION_ENV = "QUOTE_VENDOR_LIVE_EVALUATION_NON_EXPORT_CONTROLLED";
const CONFIRMATION_FLAG = "--confirm-non-export-controlled";
const capturedEvaluationFiles = new WeakMap<
  VendorQuoteAdapterInput,
  LiveEvaluationUploadFiles
>();

/** Computes a SHA-256 digest without loading the complete file into memory. */
export async function sha256File(filePath: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk);
  }
  return digest.digest("hex");
}

/** Reads the explicit operator confirmation required before evaluation upload. */
export function hasNonExportControlledConfirmation(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return argv.includes(CONFIRMATION_FLAG) || env[CONFIRMATION_ENV] === "true";
}

export type StagedLiveEvaluationFiles = {
  authorization: LiveEvaluationAuthorization;
  cadPath: string;
  drawingPath: string | null;
  cleanup: () => Promise<void>;
};

/** Copies, locks down, and hashes the exact bytes used by a live evaluation. */
export async function stageLiveEvaluationFiles(input: {
  cadPath: string;
  drawingPath: string | null;
  confirmedNonExportControlled: boolean;
}): Promise<StagedLiveEvaluationFiles> {
  if (!input.confirmedNonExportControlled) {
    throw new Error(
      `Live provider evaluation requires ${CONFIRMATION_FLAG} or ${CONFIRMATION_ENV}=true.`,
    );
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "overdrafter-live-evaluation-"));
  await fs.chmod(tempDir, 0o700);
  const cadPath = path.join(tempDir, `cad${path.extname(input.cadPath)}`);
  const drawingPath = input.drawingPath
    ? path.join(tempDir, `drawing${path.extname(input.drawingPath)}`)
    : null;

  try {
    await fs.copyFile(input.cadPath, cadPath);
    await fs.chmod(cadPath, 0o600);
    if (input.drawingPath && drawingPath) {
      await fs.copyFile(input.drawingPath, drawingPath);
      await fs.chmod(drawingPath, 0o600);
    }

    const [cadFileSha256, drawingFileSha256] = await Promise.all([
      sha256File(cadPath),
      drawingPath ? sha256File(drawingPath) : Promise.resolve(null),
    ]);

    return {
      authorization: {
        nonExportControlled: true,
        cadFileSha256,
        drawingFileSha256,
      },
      cadPath,
      drawingPath,
      cleanup: () => fs.rm(tempDir, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function uploadMimeType(fileName: string): string {
  return path.extname(fileName).toLowerCase() === ".pdf"
    ? "application/pdf"
    : "application/octet-stream";
}

function buildUploadFile(name: string, buffer: Buffer): LiveEvaluationUploadFile {
  return {
    name,
    mimeType: uploadMimeType(name),
    buffer,
  };
}

/**
 * Captures the authorized bytes into memory so later browser waits cannot swap
 * the file that is ultimately uploaded.
 */
async function captureAuthorizedLiveEvaluationFiles(
  input: VendorQuoteAdapterInput,
): Promise<LiveEvaluationUploadFiles | null> {
  const authorization = input.liveEvaluationAuthorization;
  const stagedCadFile = input.stagedCadFile;
  const stagedDrawingFile = input.stagedDrawingFile;
  if (
    authorization?.nonExportControlled !== true ||
    authorization.drawingFileSha256 !==
      (stagedDrawingFile?.trustedContentSha256 ?? null)
  ) {
    return null;
  }
  if (!stagedCadFile) {
    return null;
  }
  if (authorization.cadFileSha256 !== stagedCadFile.trustedContentSha256) {
    return null;
  }

  const [cadBuffer, drawingBuffer] = await Promise.all([
    fs.readFile(stagedCadFile.localPath),
    stagedDrawingFile
      ? fs.readFile(stagedDrawingFile.localPath)
      : Promise.resolve(null),
  ]).catch(() => [null, null] as const);
  if (!cadBuffer) {
    return null;
  }

  const cadFileSha256 = createHash("sha256").update(cadBuffer).digest("hex");
  const drawingFileSha256 = drawingBuffer
    ? createHash("sha256").update(drawingBuffer).digest("hex")
    : null;
  if (
    cadFileSha256 !== authorization.cadFileSha256 ||
    drawingFileSha256 !== authorization.drawingFileSha256
  ) {
    return null;
  }

  // A staged drawing is captured or authorization fails above. Bound inputs
  // therefore always preserve drawing presence one-for-one.
  return {
    cad: buildUploadFile(stagedCadFile.originalName, cadBuffer),
    drawing: stagedDrawingFile && drawingBuffer
      ? buildUploadFile(stagedDrawingFile.originalName, drawingBuffer)
      : null,
  };
}

/**
 * Produces the only input identity that adapters recognize as live evaluation.
 * Captured buffers stay in this module-private WeakMap and cannot be supplied
 * through the public adapter input contract.
 */
export async function authorizeLiveEvaluationInput(
  input: VendorQuoteAdapterInput,
): Promise<VendorQuoteAdapterInput | null> {
  const files = await captureAuthorizedLiveEvaluationFiles(input);
  if (!files) {
    return null;
  }

  const authorizedInput: VendorQuoteAdapterInput = {
    ...input,
    executionContext: "live_evaluation",
  };
  capturedEvaluationFiles.set(authorizedInput, files);
  return authorizedInput;
}

/** Returns captured evaluation bytes only for an internally authorized input. */
export function getAuthorizedLiveEvaluationFiles(
  input: VendorQuoteAdapterInput,
): LiveEvaluationUploadFiles | null {
  return capturedEvaluationFiles.get(input) ?? null;
}
