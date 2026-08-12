import type {
  ApprovedRequirementRecord,
  JobFileRecord,
  PartRecord,
  StagedFile,
  VendorName,
} from "./types.js";

type ScopeFileInput = {
  file: JobFileRecord | null;
  stagedFile: StagedFile | null;
};

function buildScopeFile(input: ScopeFileInput) {
  if (!input.file || !input.stagedFile) {
    return null;
  }

  const trustedContentSha256 = input.stagedFile.trustedContentSha256;
  if (!trustedContentSha256) {
    throw new Error(`Staged file ${input.file.id} is missing its worker-trusted digest.`);
  }

  return {
    fileId: input.file.id,
    sha256: trustedContentSha256,
    name: input.file.original_name,
    mimeType: input.file.mime_type ?? null,
    sizeBytes: input.file.size_bytes ?? null,
  };
}

/**
 * Captures exactly the immutable files and approved manufacturing fields that
 * the worker is about to disclose to one vendor for one quantity.
 */
export function buildQuoteLaneScopeSnapshot(input: {
  part: PartRecord;
  cadFile: JobFileRecord | null;
  drawingFile: JobFileRecord | null;
  stagedCadFile: StagedFile | null;
  stagedDrawingFile: StagedFile | null;
  requirement: ApprovedRequirementRecord;
  vendor: VendorName;
  requestedQuantity: number;
}) {
  const cad = buildScopeFile({ file: input.cadFile, stagedFile: input.stagedCadFile });
  if (!cad) {
    throw new Error(`Part ${input.part.id} cannot be quoted without a staged CAD file.`);
  }

  return {
    schema: "quote-lane-scope.v1",
    vendor: input.vendor,
    quantity: input.requestedQuantity,
    part: {
      id: input.part.id,
      cad,
      drawing: buildScopeFile({
        file: input.drawingFile,
        stagedFile: input.stagedDrawingFile,
      }),
    },
    requirements: {
      id: input.requirement.id,
      capturedAt: input.requirement.updated_at ?? null,
      description: input.requirement.description,
      partNumber: input.requirement.part_number,
      revision: input.requirement.revision,
      material: input.requirement.material,
      finish: input.requirement.finish,
      tightestToleranceInch: input.requirement.tightest_tolerance_inch,
      requestedDeliveryDate: input.requirement.requested_by_date,
      specification: input.requirement.spec_snapshot ?? null,
    },
  };
}
