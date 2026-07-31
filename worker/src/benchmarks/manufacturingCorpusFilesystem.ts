import type {
  ManufacturingCorpusCase,
  ManufacturingCorpusManifest,
} from "./manufacturingCorpusContract.js";
import {
  verifyManufacturingCorpusArtifactFilesystem,
  type VerifyManufacturingCorpusArtifactFilesystemOptions,
} from "./manufacturingCorpusArtifactFilesystem.js";
import {
  createManufacturingCorpusManifestDiagnostic,
  normalizeManufacturingCorpusManifestDiagnostics,
  type ManufacturingCorpusManifestDiagnostic,
  type ManufacturingCorpusManifestDiagnosticCode,
} from "./manufacturingCorpusFilesystemDiagnostics.js";
import {
  loadManufacturingCorpusManifest,
  type LoadManufacturingCorpusManifestOptions,
} from "./manufacturingCorpusManifestLoader.js";
import { resolveManufacturingCorpusRootBindings } from "./manufacturingCorpusRootBindings.js";

/** Absolute in-memory ceiling for verified annotation JSON handoff. */
export const MAX_MANUFACTURING_CORPUS_VERIFIED_ANNOTATION_BYTES =
  64 * 1024 * 1024;

export type PrepareManufacturingCorpusFilesystemOptions = Readonly<{
  manifestPath: string;
  externalBindings?: ReadonlyMap<string, string>;
  manifestByteLimit?: number;
  /** @internal Receives an artifact ID only, immediately before open. */
  beforeArtifactOpenForTest?: (
    artifactId: string,
  ) => Promise<void> | void;
  /** @internal Receives an artifact ID only, after its handle has been read. */
  afterArtifactReadForTest?: (
    artifactId: string,
  ) => Promise<void> | void;
}>;
export type ManufacturingCorpusFilesystemCaseResult = Readonly<{
  caseId: string;
  state: "failed" | "passed";
  diagnosticCodes: readonly ManufacturingCorpusManifestDiagnosticCode[];
}>;
export type ManufacturingCorpusFilesystemValidationResult = Readonly<{
  state: "validated";
  integrityPassed: boolean;
  manifestSha256: string;
  caseResults: readonly ManufacturingCorpusFilesystemCaseResult[];
  diagnostics: readonly ManufacturingCorpusManifestDiagnostic[];
  verifiedAnnotationBytesByCaseId: ReadonlyMap<string, Uint8Array>;
}>;
export type FailedManufacturingCorpusFilesystemPreparation = Readonly<{
  state: "failed";
  diagnostics: readonly ManufacturingCorpusManifestDiagnostic[];
}>;
export type PreparedManufacturingCorpusFilesystem = Readonly<{
  /**
   * Internal parsed metadata for policy preflight. Never publicly serialize.
   */
  manifest: ManufacturingCorpusManifest;
  manifestSha256: string;
  validateArtifacts: (
    caseIds: readonly string[],
  ) => Promise<ManufacturingCorpusFilesystemValidationResult>;
}>;
export type SuccessfulManufacturingCorpusFilesystemPreparation = Readonly<{
  state: "prepared";
  prepared: PreparedManufacturingCorpusFilesystem;
}>;
export type ManufacturingCorpusFilesystemPreparationResult =
  | FailedManufacturingCorpusFilesystemPreparation
  | SuccessfulManufacturingCorpusFilesystemPreparation;
export type ManufacturingCorpusFilesystemTerminalResult =
  | FailedManufacturingCorpusFilesystemPreparation
  | ManufacturingCorpusFilesystemValidationResult;

function caseDiagnostic(
  code: ManufacturingCorpusManifestDiagnosticCode,
  caseId: string,
) {
  return createManufacturingCorpusManifestDiagnostic(code, "case", caseId);
}

function compareText(left: string, right: string) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function diagnosticCodes(
  diagnostics: readonly ManufacturingCorpusManifestDiagnostic[],
) {
  return [...new Set(diagnostics.map((item) => item.code))].sort(compareText);
}

function failedPreparation(
  diagnostics: readonly ManufacturingCorpusManifestDiagnostic[],
): FailedManufacturingCorpusFilesystemPreparation {
  return {
    state: "failed",
    diagnostics: normalizeManufacturingCorpusManifestDiagnostics(diagnostics),
  };
}

function requestFailure(
  manifestSha256: string,
  diagnostics: readonly ManufacturingCorpusManifestDiagnostic[],
): ManufacturingCorpusFilesystemValidationResult {
  const normalized = normalizeManufacturingCorpusManifestDiagnostics(
    diagnostics,
  );
  const byCase = new Map<string, ManufacturingCorpusManifestDiagnostic[]>();
  for (const item of normalized) {
    if (item.recordKind !== "case" || item.recordId === null) {
      continue;
    }
    const values = byCase.get(item.recordId) ?? [];
    values.push(item);
    byCase.set(item.recordId, values);
  }
  return {
    state: "validated",
    integrityPassed: false,
    manifestSha256,
    caseResults: [...byCase.entries()]
      .map(([caseId, values]) => ({
        caseId,
        state: "failed" as const,
        diagnosticCodes: diagnosticCodes(values),
      }))
      .sort((left, right) => compareText(left.caseId, right.caseId)),
    diagnostics: normalized,
    verifiedAnnotationBytesByCaseId: new Map(),
  };
}

class PreparedFilesystem implements PreparedManufacturingCorpusFilesystem {
  readonly manifest: ManufacturingCorpusManifest;
  readonly manifestSha256: string;
  readonly #canonicalRoots: ReadonlyMap<string, string>;
  readonly #afterRead:
    | VerifyManufacturingCorpusArtifactFilesystemOptions["afterReadForTest"]
    | undefined;
  readonly #beforeOpen:
    | VerifyManufacturingCorpusArtifactFilesystemOptions["beforeOpenForTest"]
    | undefined;

  constructor(
    manifest: ManufacturingCorpusManifest,
    manifestSha256: string,
    canonicalRoots: ReadonlyMap<string, string>,
    beforeOpen:
      | VerifyManufacturingCorpusArtifactFilesystemOptions["beforeOpenForTest"]
      | undefined,
    afterRead:
      | VerifyManufacturingCorpusArtifactFilesystemOptions["afterReadForTest"]
      | undefined,
  ) {
    this.manifest = manifest;
    this.manifestSha256 = manifestSha256;
    this.#canonicalRoots = canonicalRoots;
    this.#beforeOpen = beforeOpen;
    this.#afterRead = afterRead;
  }

  async validateArtifacts(
    requestedCaseIds: readonly string[],
  ): Promise<ManufacturingCorpusFilesystemValidationResult> {
    const cases = new Map(
      this.manifest.cases.map((value) => [value.caseId, value]),
    );
    const requestDiagnostics: ManufacturingCorpusManifestDiagnostic[] = [];
    const counts = new Map<string, number>();
    for (const caseId of requestedCaseIds) {
      counts.set(caseId, (counts.get(caseId) ?? 0) + 1);
    }
    for (const [caseId, count] of counts) {
      if (count > 1) {
        requestDiagnostics.push(
          caseDiagnostic("duplicate_requested_case_id", caseId),
        );
      }
      if (!cases.has(caseId)) {
        requestDiagnostics.push(caseDiagnostic("case_not_found", caseId));
      }
    }
    if (requestDiagnostics.length > 0) {
      return requestFailure(this.manifestSha256, requestDiagnostics);
    }

    const diagnostics: ManufacturingCorpusManifestDiagnostic[] = [];
    const caseResults: ManufacturingCorpusFilesystemCaseResult[] = [];
    const verifiedAnnotationBytesByCaseId = new Map<string, Uint8Array>();
    for (const caseId of [...counts.keys()].sort(compareText)) {
      const corpusCase = cases.get(caseId) as ManufacturingCorpusCase;
      const validated = await this.#validateCase(corpusCase);
      diagnostics.push(...validated.diagnostics);
      const codes = diagnosticCodes(validated.diagnostics);
      caseResults.push({
        caseId,
        state: codes.length === 0 ? "passed" : "failed",
        diagnosticCodes: codes,
      });
      if (codes.length === 0 && validated.annotationBytes !== null) {
        verifiedAnnotationBytesByCaseId.set(
          caseId,
          new Uint8Array(validated.annotationBytes),
        );
      }
    }
    const normalized = normalizeManufacturingCorpusManifestDiagnostics(
      diagnostics,
    );
    return {
      state: "validated",
      integrityPassed: normalized.length === 0,
      manifestSha256: this.manifestSha256,
      caseResults,
      diagnostics: normalized,
      verifiedAnnotationBytesByCaseId,
    };
  }

  async #validateCase(corpusCase: ManufacturingCorpusCase) {
    const diagnostics: ManufacturingCorpusManifestDiagnostic[] = [];
    for (const artifact of corpusCase.artifacts) {
      const result = await verifyManufacturingCorpusArtifactFilesystem(
        artifact,
        this.#canonicalRoots,
        {
          beforeOpenForTest: this.#beforeOpen,
          afterReadForTest: this.#afterRead,
        },
      );
      diagnostics.push(...result.diagnostics);
    }
    const annotation =
      await verifyManufacturingCorpusArtifactFilesystem(
        corpusCase.annotationArtifact,
        this.#canonicalRoots,
        {
          captureVerifiedBytes: true,
          captureByteLimit: Math.min(
            corpusCase.executionLimits.maxOutputBytes,
            MAX_MANUFACTURING_CORPUS_VERIFIED_ANNOTATION_BYTES,
          ),
          beforeOpenForTest: this.#beforeOpen,
          afterReadForTest: this.#afterRead,
        },
      );
    diagnostics.push(...annotation.diagnostics);
    return {
      diagnostics:
        normalizeManufacturingCorpusManifestDiagnostics(diagnostics),
      annotationBytes: annotation.verifiedBytes,
    };
  }
}

export async function prepareManufacturingCorpusFilesystem(
  options: PrepareManufacturingCorpusFilesystemOptions,
): Promise<ManufacturingCorpusFilesystemPreparationResult> {
  try {
    const loadOptions: LoadManufacturingCorpusManifestOptions = {
      manifestByteLimit: options.manifestByteLimit,
    };
    const loaded = await loadManufacturingCorpusManifest(
      options.manifestPath,
      loadOptions,
    );
    if (loaded.state === "failed") {
      return failedPreparation(loaded.diagnostics);
    }
    const roots = await resolveManufacturingCorpusRootBindings(
      loaded,
      options.externalBindings ?? new Map(),
    );
    if (roots.state === "failed") {
      return failedPreparation(roots.diagnostics);
    }
    return {
      state: "prepared",
      prepared: new PreparedFilesystem(
        loaded.manifest,
        loaded.manifestSha256,
        roots.canonicalDirectoriesByRootId,
        options.beforeArtifactOpenForTest,
        options.afterArtifactReadForTest,
      ),
    };
  } catch {
    return failedPreparation([
      createManufacturingCorpusManifestDiagnostic(
        "manifest_read_failed",
        "manifest",
      ),
    ]);
  }
}

/**
 * Validates every case without policy filtering.
 *
 * Tenant- or consent-aware callers must instead prepare, run metadata
 * preflight, and pass only its authorized case IDs to `validateArtifacts`.
 */
export async function validateManufacturingCorpusFilesystem(
  options: PrepareManufacturingCorpusFilesystemOptions,
): Promise<ManufacturingCorpusFilesystemTerminalResult> {
  const prepared = await prepareManufacturingCorpusFilesystem(options);
  if (prepared.state === "failed") {
    return prepared;
  }
  return prepared.prepared.validateArtifacts(
    prepared.prepared.manifest.cases.map(
      (corpusCase) => corpusCase.caseId,
    ),
  );
}

function sanitizedCaseId(caseId: string) {
  return createManufacturingCorpusManifestDiagnostic(
    "case_not_found",
    "case",
    caseId,
  ).recordId;
}

/** Reconstructs an allowlisted terminal shape and never serializes bytes. */
export function serializeManufacturingCorpusFilesystemResult(
  result: ManufacturingCorpusFilesystemTerminalResult,
) {
  if (result.state === "failed") {
    return `${JSON.stringify(
      {
        state: result.state,
        diagnostics: normalizeManufacturingCorpusManifestDiagnostics(
          result.diagnostics,
        ),
      },
      null,
      2,
    )}\n`;
  }
  const publicResult = {
    state: result.state,
    integrityPassed: result.integrityPassed,
    manifestSha256: result.manifestSha256,
    caseResults: result.caseResults.map((caseResult) => ({
      caseId: sanitizedCaseId(caseResult.caseId),
      state: caseResult.state,
      diagnosticCodes: [...caseResult.diagnosticCodes].sort(compareText),
    })),
    diagnostics: normalizeManufacturingCorpusManifestDiagnostics(
      result.diagnostics,
    ),
  };
  publicResult.caseResults.sort((left, right) =>
    compareText(left.caseId ?? "", right.caseId ?? ""),
  );
  return `${JSON.stringify(publicResult, null, 2)}\n`;
}
