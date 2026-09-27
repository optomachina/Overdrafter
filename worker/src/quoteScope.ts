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

type ConfirmedDestination = {
  confirmationRevision: string;
  street: string;
  city: string;
  region: string | null;
  postalCode: string;
  country: string;
  state: "confirmed";
};

export type WorkerSourcingIntent = {
  destination: ConfirmedDestination | null;
  activeDeadline: string | null;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredAddressField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim().length === 0) {
    throw new Error("Worker scope requires a complete confirmed sourcing destination.");
  }
  return field;
}

/** Validates the server-owned confirmation projection before any adapter work. */
export function parseWorkerSourcingIntent(value: unknown): WorkerSourcingIntent {
  if (!record(value)) {
    throw new Error("Worker sourcing intent is unavailable.");
  }
  const rawDestination = value.destination;
  let destination: ConfirmedDestination | null = null;
  if (rawDestination !== null) {
    if (!record(rawDestination) || rawDestination.state !== "confirmed") {
      throw new Error("Worker scope requires a confirmed sourcing destination.");
    }
    const country = requiredAddressField(rawDestination, "country");
    const region = rawDestination.region;
    if (country === "US" && (typeof region !== "string" || region.trim().length === 0)) {
      throw new Error("Worker scope requires a complete confirmed sourcing destination.");
    }
    if (region !== null && typeof region !== "string") {
      throw new Error("Worker scope requires a complete confirmed sourcing destination.");
    }
    const confirmationRevision = requiredAddressField(rawDestination, "confirmationRevision");
    if (!/^[1-9]\d*$/.test(confirmationRevision)) {
      throw new Error("Worker scope requires a valid sourcing confirmation revision.");
    }
    destination = {
      confirmationRevision,
      street: requiredAddressField(rawDestination, "street"),
      city: requiredAddressField(rawDestination, "city"),
      region: region as string | null,
      postalCode: requiredAddressField(rawDestination, "postalCode"),
      country,
      state: "confirmed",
    };
  }

  const rawDeadline = value.activeDeadline;
  if (rawDeadline !== null) {
    if (typeof rawDeadline !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(rawDeadline)
      || Number.isNaN(Date.parse(`${rawDeadline}T00:00:00Z`))
      || new Date(`${rawDeadline}T00:00:00Z`).toISOString().slice(0, 10) !== rawDeadline) {
      throw new Error("Worker scope has an invalid active deadline.");
    }
  }
  return { destination, activeDeadline: rawDeadline as string | null };
}

function sourcingSpecification(value: unknown): Record<string, unknown> {
  const specification = record(value) ? { ...value } : {};
  delete specification.requestedByDate;
  if (record(specification.shipping)) {
    const shipping = { ...specification.shipping };
    delete shipping.requestedByDateOverride;
    specification.shipping = shipping;
  }
  return specification;
}

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
  sourcingIntent: WorkerSourcingIntent;
  vendor: VendorName;
  requestedQuantity: number;
}) {
  const cad = buildScopeFile({ file: input.cadFile, stagedFile: input.stagedCadFile });
  if (!cad) {
    throw new Error(`Part ${input.part.id} cannot be quoted without a staged CAD file.`);
  }

  if (input.vendor === "xometry" && !input.sourcingIntent.destination) {
    throw new Error("Xometry disclosure requires a confirmed sourcing destination.");
  }

  return {
    schema: "quote-lane-scope.v1",
    vendor: input.vendor,
    quantity: input.requestedQuantity,
    ...(input.sourcingIntent.destination ? { destination: input.sourcingIntent.destination } : {}),
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
      requestedDeliveryDate: input.sourcingIntent.activeDeadline,
      specification: sourcingSpecification(input.requirement.spec_snapshot),
    },
  };
}
