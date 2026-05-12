/**
 * Shared builders for the file-related fields of `VendorQuoteAdapterInput`.
 *
 * The CAD + drawing file payloads (cadFile, drawingFile, stagedCadFile,
 * stagedDrawingFile) follow a consistent shape across every vendor adapter
 * harness (fictiv.live.test.ts, xometryQuantitySweep.ts,
 * fictivQuantitySweep.ts, etc.). Extracting the construction here keeps each
 * harness lean and avoids SonarCloud duplicate-line flags on what is purely
 * boilerplate.
 */
import path from "node:path";
import type { VendorQuoteAdapterInput } from "../types.js";

type VendorQuoteFilePayload = Pick<
  VendorQuoteAdapterInput,
  "cadFile" | "drawingFile" | "stagedCadFile" | "stagedDrawingFile"
>;

export type BuildVendorQuoteFilesOptions = {
  cadPath: string;
  drawingPath?: string | null;
  /**
   * Stable IDs distinguish file rows in downstream artifacts (e.g.,
   * `cad-${idPrefix}` and `drawing-${idPrefix}`). Pass the harness name
   * (e.g., "live", "sweep") to keep IDs human-readable.
   */
  idPrefix: string;
  /**
   * Logical job ID used as `job_id`. Defaults to `job-${idPrefix}`.
   */
  jobId?: string;
  /**
   * Storage bucket name. Defaults to "job-files" which matches the worker's
   * default Supabase storage bucket.
   */
  storageBucket?: string;
  /**
   * Storage path stem (without extension). Defaults to `cad/${idPrefix}`
   * for the CAD file and `drawing/${idPrefix}` for the drawing.
   */
  cadStoragePath?: string;
  drawingStoragePath?: string;
};

/**
 * Returns the cadFile/drawingFile/stagedCadFile/stagedDrawingFile fields for
 * a `VendorQuoteAdapterInput`. When `drawingPath` is null/undefined, the
 * drawing fields are returned as `null`.
 */
export function buildVendorQuoteFilePayload(
  options: BuildVendorQuoteFilesOptions,
): VendorQuoteFilePayload {
  const {
    cadPath,
    drawingPath = null,
    idPrefix,
    jobId = `job-${idPrefix}`,
    storageBucket = "job-files",
    cadStoragePath,
    drawingStoragePath,
  } = options;

  const cadStorage = cadStoragePath ?? `cad/${idPrefix}.step`;
  const drawingStorage = drawingStoragePath ?? `drawing/${idPrefix}.pdf`;

  const drawingFile = drawingPath
    ? {
        id: `drawing-${idPrefix}`,
        job_id: jobId,
        storage_bucket: storageBucket,
        storage_path: drawingStorage,
        original_name: path.basename(drawingPath),
        file_kind: "drawing" as const,
      }
    : null;

  const stagedDrawingFile = drawingPath
    ? {
        originalName: path.basename(drawingPath),
        localPath: drawingPath,
        storageBucket,
        storagePath: drawingStorage,
      }
    : null;

  return {
    cadFile: {
      id: `cad-${idPrefix}`,
      job_id: jobId,
      storage_bucket: storageBucket,
      storage_path: cadStorage,
      original_name: path.basename(cadPath),
      file_kind: "cad",
    },
    drawingFile,
    stagedCadFile: {
      originalName: path.basename(cadPath),
      localPath: cadPath,
      storageBucket,
      storagePath: cadStorage,
    },
    stagedDrawingFile,
  };
}
