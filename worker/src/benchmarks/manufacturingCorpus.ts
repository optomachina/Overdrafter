import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const MANUFACTURING_CORPUS_SCHEMA_VERSION =
  "manufacturing-characterization-corpus.v1";
export const MANUFACTURING_ANNOTATION_SCHEMA_VERSION =
  "manufacturing-characterization-annotation.v1";
export const MANUFACTURING_BENCHMARK_RESULT_SCHEMA_VERSION =
  "manufacturing-characterization-benchmark-result.v1";
export const MANUFACTURING_BLIND_PLAN_SCHEMA_VERSION =
  "manufacturing-characterization-blind-plan.v1";

const processFamilySchema = z.enum([
  "cnc_milling",
  "cnc_turning",
  "mill_turn",
  "sheet_metal",
  "additive_polymer",
  "additive_metal",
  "welding_fabrication",
  "casting",
  "injection_molding",
  "other",
]);

const supportTargetSchema = z.enum([
  "broad_estimate",
  "characterization_only",
]);

const sourceClassSchema = z.enum([
  "synthetic",
  "public_standard",
  "open_license",
  "company_owned",
  "consented_customer",
]);

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const stableIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);
const isoDateTimeSchema = z.string().datetime({ offset: true });

const relativePathSchema = z.string().min(1).refine(
  (value) => {
    if (path.isAbsolute(value)) {
      return false;
    }

    const normalized = path.normalize(value);
    return normalized !== ".." && !normalized.startsWith(`..${path.sep}`);
  },
  "must be a contained relative path",
);

const artifactReferenceSchema = z.object({
  role: z.enum(["cad_model", "drawing", "bom", "other"]),
  rootId: stableIdSchema,
  path: relativePathSchema,
  mediaType: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  sha256: sha256Schema,
});

const annotationReferenceSchema = z.object({
  rootId: stableIdSchema,
  path: relativePathSchema,
  byteSize: z.number().int().nonnegative(),
  sha256: sha256Schema,
});

const rightsRecordSchema = z.object({
  id: stableIdSchema,
  sourceClass: sourceClassSchema,
  reviewStatus: z.enum(["pending", "approved", "revoked", "expired"]),
  rightsBasis: z.string().min(1),
  evidenceRef: z.string().min(1),
  evidenceSha256: sha256Schema.nullable(),
  effectiveAt: isoDateTimeSchema.nullable(),
  expiresAt: isoDateTimeSchema.nullable(),
  approvedByRole: z.string().min(1).nullable(),
  approvedAt: isoDateTimeSchema.nullable(),
  permissions: z.object({
    humanAnnotation: z.boolean(),
    localParserEvaluation: z.boolean(),
    geometrySdkEvaluation: z.boolean(),
    modelValidation: z.boolean(),
    modelTraining: z.boolean(),
    commercialProductImprovement: z.boolean(),
    internalDemonstration: z.boolean(),
    publication: z.boolean(),
  }),
  processorPolicy: z.object({
    mode: z.enum(["local_only", "allowlist"]),
    allowedProcessors: z.array(stableIdSchema),
    rawOutputRetentionAllowed: z.boolean(),
  }),
  tenantScopeRefs: z.array(z.string().min(1)),
  crossTenantUse: z.boolean(),
  redistribution: z.object({
    assets: z.enum([
      "internal_only",
      "metadata_only",
      "derived_noninvertible",
      "full_assets",
    ]),
    annotations: z.enum([
      "internal_only",
      "metadata_only",
      "derived_noninvertible",
      "full_assets",
    ]),
  }),
  lifecycle: z.object({
    sourceExpiresAt: isoDateTimeSchema.nullable(),
    derivedExpiresAt: isoDateTimeSchema.nullable(),
    revokedAt: isoDateTimeSchema.nullable(),
    deletionRequestRef: z.string().min(1).nullable(),
    purgeVerifiedAt: isoDateTimeSchema.nullable(),
    legalHold: z.boolean(),
  }),
});

const corpusRootSchema = z.discriminatedUnion("kind", [
  z.object({
    id: stableIdSchema,
    kind: z.literal("manifest_relative"),
    path: relativePathSchema,
    access: z.enum(["redistributable", "internal_only"]),
  }),
  z.object({
    id: stableIdSchema,
    kind: z.literal("external_mount"),
    access: z.literal("internal_only"),
  }),
]);

const expectedExecutionSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("success"),
    diagnosticCodes: z.array(z.string()).length(0),
  }),
  z.object({
    outcome: z.literal("bounded_failure"),
    diagnosticCodes: z.array(stableIdSchema).min(1),
  }),
]);

const corpusCaseSchema = z.object({
  id: stableIdSchema,
  processFamilies: z.array(processFamilySchema).min(1),
  supportTarget: supportTargetSchema,
  sourceClass: sourceClassSchema,
  dataClassification: z.enum([
    "public",
    "internal",
    "confidential",
    "controlled",
  ]),
  opaqueSourceRef: z.string().min(1),
  redactionStatus: z.enum([
    "not_required",
    "pending",
    "verified",
  ]),
  rightsId: stableIdSchema,
  artifacts: z.array(artifactReferenceSchema).min(1),
  annotation: annotationReferenceSchema,
  executionLimits: z.object({
    maxSourceBytes: z.number().int().positive(),
    maxPackageBytes: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
    memoryMb: z.number().int().positive(),
  }),
  expectedExecution: expectedExecutionSchema,
  tags: z.array(stableIdSchema),
});

const corpusManifestSchema = z.object({
  schemaVersion: z.literal(MANUFACTURING_CORPUS_SCHEMA_VERSION),
  corpusVersion: z.string().min(1),
  roots: z.array(corpusRootSchema).min(1),
  targets: z.array(
    z.object({
      processFamily: processFamilySchema,
      supportTarget: supportTargetSchema,
      minimumPackages: z.number().int().nonnegative(),
      minimumConsentedRealPackages: z.number().int().nonnegative(),
    }),
  ).min(1),
  rights: z.array(rightsRecordSchema),
  cases: z.array(corpusCaseSchema),
});

const evidenceSchema = z.object({
  artifactRole: z.string().min(1),
  locator: z.string().min(1),
});

const manufacturingAnnotationSchema = z.object({
  schemaVersion: z.literal(MANUFACTURING_ANNOTATION_SCHEMA_VERSION),
  annotationVersion: z.string().min(1),
  caseId: stableIdSchema,
  review: z.discriminatedUnion("state", [
    z.object({
      state: z.literal("pending_manufacturing_review"),
      reviewerRole: z.null(),
      reviewedAt: z.null(),
    }),
    z.object({
      state: z.literal("approved"),
      reviewerRole: z.string().min(1),
      reviewedAt: isoDateTimeSchema,
    }),
  ]),
  expected: z.object({
    productStructure: z.object({
      definitionCount: z.number().int().nonnegative().nullable(),
      occurrenceCount: z.number().int().nonnegative().nullable(),
    }),
    units: z.object({
      length: z.string().min(1),
    }),
    commonFeatures: z.array(
      z.object({
        class: z.string().min(1),
        count: z.number().int().nonnegative(),
        parameters: z.record(z.unknown()),
        evidence: z.array(evidenceSchema).min(1),
      }),
    ),
    requirements: z.array(
      z.object({
        key: z.string().min(1),
        value: z.unknown(),
        unit: z.string().min(1).nullable(),
        governing: z.boolean(),
        evidence: z.array(evidenceSchema).min(1),
      }),
    ),
    candidateRoutes: z.array(
      z.object({
        processFamily: processFamilySchema,
        state: z.enum(["applicable", "possible", "excluded"]),
        evidence: z.array(evidenceSchema),
      }),
    ),
    unsupportedStates: z.array(
      z.object({
        code: stableIdSchema,
        evidence: z.array(evidenceSchema).min(1),
      }),
    ),
  }),
});

export type ManufacturingCorpusManifest = z.infer<typeof corpusManifestSchema>;
export type ManufacturingCorpusCase = z.infer<typeof corpusCaseSchema>;
export type ManufacturingAnnotation = z.infer<typeof manufacturingAnnotationSchema>;
export type ManufacturingProcessFamily = z.infer<typeof processFamilySchema>;

export type CorpusDiagnostic = {
  code: string;
  caseId: string | null;
  detail: string;
};

export type CorpusCaseResult = {
  caseId: string;
  integrityPassed: boolean;
  annotationReview: "approved" | "pending_manufacturing_review" | "unavailable";
  rightsReview: "approved" | "pending" | "revoked" | "expired" | "unavailable";
  eligibleForCoverage: boolean;
  eligibilityBlockers: string[];
};

export type CorpusCoverageResult = {
  processFamily: ManufacturingProcessFamily;
  supportTarget: z.infer<typeof supportTargetSchema>;
  minimumPackages: number;
  eligiblePackages: number;
  presentPackages: number;
  minimumConsentedRealPackages: number;
  eligibleConsentedRealPackages: number;
  promotionBlocked: boolean;
  gapCodes: string[];
};

export type ManufacturingCorpusReport = {
  schemaVersion: typeof MANUFACTURING_BENCHMARK_RESULT_SCHEMA_VERSION;
  corpusSchemaVersion: typeof MANUFACTURING_CORPUS_SCHEMA_VERSION;
  corpusVersion: string;
  manifestSha256: string;
  integrityPassed: boolean;
  caseResults: CorpusCaseResult[];
  coverage: CorpusCoverageResult[];
  diagnostics: CorpusDiagnostic[];
};

export type BlindedRunPlan = {
  schemaVersion: typeof MANUFACTURING_BLIND_PLAN_SCHEMA_VERSION;
  corpusVersion: string;
  manifestSha256: string;
  purpose: BlindEvaluationPurpose;
  processor: string;
  cases: Array<{
    caseId: string;
    artifacts: ManufacturingCorpusCase["artifacts"];
    executionLimits: ManufacturingCorpusCase["executionLimits"];
  }>;
  excludedCases: Array<{
    caseId: string;
    reasonCodes: string[];
  }>;
};

export type ValidateManufacturingCorpusOptions = {
  manifestPath: string;
  externalRoots?: Record<string, string>;
  now?: Date;
};

export type BlindEvaluationPurpose =
  | "local_parser_evaluation"
  | "geometry_sdk_evaluation";

export type BuildBlindedRunPlanOptions =
  ValidateManufacturingCorpusOptions & {
    purpose?: BlindEvaluationPurpose;
    processor?: string;
  };

class CorpusContractError extends Error {
  readonly diagnostics: CorpusDiagnostic[];

  constructor(message: string, diagnostics: CorpusDiagnostic[]) {
    super(message);
    this.name = "CorpusContractError";
    this.diagnostics = diagnostics;
  }
}

function stableCompare(left: string, right: string) {
  return left.localeCompare(right, "en");
}

function sortDiagnostics(diagnostics: CorpusDiagnostic[]) {
  return [...diagnostics].sort((left, right) => {
    const caseOrder = stableCompare(left.caseId ?? "", right.caseId ?? "");
    if (caseOrder !== 0) {
      return caseOrder;
    }

    const codeOrder = stableCompare(left.code, right.code);
    if (codeOrder !== 0) {
      return codeOrder;
    }

    return stableCompare(left.detail, right.detail);
  });
}

function formatZodDiagnostics(error: z.ZodError, code: string): CorpusDiagnostic[] {
  return error.issues.map((issue) => ({
    code,
    caseId: null,
    detail: `${issue.path.join(".") || "<root>"}: ${issue.message}`,
  }));
}

async function sha256File(filePath: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }

  return hash.digest("hex");
}

async function resolveContainedFile(rootPath: string, relativePath: string) {
  const parsedRelativePath = relativePathSchema.safeParse(relativePath);
  if (!parsedRelativePath.success) {
    throw new Error(`unsafe relative path: ${relativePath}`);
  }

  const rootRealPath = await fs.realpath(rootPath);
  const candidatePath = path.resolve(rootRealPath, parsedRelativePath.data);
  const relativeToRoot = path.relative(rootRealPath, candidatePath);
  if (
    relativeToRoot === ".." ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new Error(`path escapes corpus root: ${relativePath}`);
  }

  const linkStat = await fs.lstat(candidatePath);
  if (linkStat.isSymbolicLink()) {
    throw new Error(`symbolic links are not allowed: ${relativePath}`);
  }

  const candidateRealPath = await fs.realpath(candidatePath);
  const realRelativeToRoot = path.relative(rootRealPath, candidateRealPath);
  if (
    realRelativeToRoot === ".." ||
    realRelativeToRoot.startsWith(`..${path.sep}`) ||
    path.isAbsolute(realRelativeToRoot)
  ) {
    throw new Error(`resolved path escapes corpus root: ${relativePath}`);
  }

  return candidateRealPath;
}

function assertUniqueIds(
  values: Array<{ id: string }>,
  collectionName: string,
): CorpusDiagnostic[] {
  const seen = new Set<string>();
  const diagnostics: CorpusDiagnostic[] = [];

  for (const value of values) {
    if (seen.has(value.id)) {
      diagnostics.push({
        code: "duplicate_id",
        caseId: null,
        detail: `${collectionName} contains duplicate id ${value.id}`,
      });
    }
    seen.add(value.id);
  }

  return diagnostics;
}

function resolveRoots(
  manifest: ManufacturingCorpusManifest,
  manifestDirectory: string,
  externalRoots: Record<string, string>,
) {
  const roots = new Map<string, string>();
  for (const root of manifest.roots) {
    if (root.kind === "manifest_relative") {
      roots.set(root.id, path.resolve(manifestDirectory, root.path));
      continue;
    }

    const externalPath = externalRoots[root.id];
    if (externalPath) {
      roots.set(root.id, path.resolve(externalPath));
    }
  }

  return roots;
}

async function verifyReference(input: {
  caseId: string;
  reference: {
    rootId: string;
    path: string;
    byteSize: number;
    sha256: string;
  };
  roots: Map<string, string>;
  diagnosticPrefix: string;
}) {
  const rootPath = input.roots.get(input.reference.rootId);
  if (!rootPath) {
    throw new Error(`corpus root ${input.reference.rootId} is not mounted`);
  }

  const filePath = await resolveContainedFile(rootPath, input.reference.path);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`${input.reference.path} is not a regular file`);
  }
  if (stat.size !== input.reference.byteSize) {
    throw new Error(
      `${input.diagnosticPrefix} byte size mismatch: expected ${input.reference.byteSize}, got ${stat.size}`,
    );
  }

  const actualSha256 = await sha256File(filePath);
  if (actualSha256 !== input.reference.sha256) {
    throw new Error(
      `${input.diagnosticPrefix} sha256 mismatch: expected ${input.reference.sha256}, got ${actualSha256}`,
    );
  }

  return filePath;
}

function getRightsEligibilityBlockers(
  rights: z.infer<typeof rightsRecordSchema>,
  now: Date,
) {
  const blockers: string[] = [];

  if (rights.reviewStatus !== "approved") {
    blockers.push(`rights_${rights.reviewStatus}`);
  }
  if (
    rights.reviewStatus === "approved" &&
    (rights.approvedAt === null || rights.approvedByRole === null)
  ) {
    blockers.push("rights_approval_metadata_missing");
  }
  if (!rights.permissions.localParserEvaluation) {
    blockers.push("local_parser_evaluation_not_permitted");
  }
  if (rights.lifecycle.revokedAt !== null) {
    blockers.push("rights_revoked");
  }
  if (rights.lifecycle.deletionRequestRef !== null) {
    blockers.push("source_deletion_requested");
  }
  if (rights.expiresAt !== null && new Date(rights.expiresAt) <= now) {
    blockers.push("rights_expired");
  }
  if (rights.effectiveAt !== null && new Date(rights.effectiveAt) > now) {
    blockers.push("rights_not_effective");
  }
  if (
    rights.lifecycle.sourceExpiresAt !== null &&
    new Date(rights.lifecycle.sourceExpiresAt) <= now
  ) {
    blockers.push("source_retention_expired");
  }
  if (
    rights.lifecycle.derivedExpiresAt !== null &&
    new Date(rights.lifecycle.derivedExpiresAt) <= now
  ) {
    blockers.push("derived_retention_expired");
  }

  return blockers;
}

function validateCustomerRights(
  corpusCase: ManufacturingCorpusCase,
  rights: z.infer<typeof rightsRecordSchema>,
) {
  const blockers: string[] = [];
  if (corpusCase.sourceClass !== "consented_customer") {
    return blockers;
  }

  if (rights.evidenceSha256 === null) {
    blockers.push("customer_consent_evidence_hash_missing");
  }
  if (rights.tenantScopeRefs.length === 0) {
    blockers.push("customer_tenant_scope_missing");
  }
  if (rights.crossTenantUse) {
    blockers.push("customer_cross_tenant_use_forbidden");
  }

  return blockers;
}

async function validateCase(input: {
  corpusCase: ManufacturingCorpusCase;
  rightsById: Map<string, z.infer<typeof rightsRecordSchema>>;
  roots: Map<string, string>;
  now: Date;
}) {
  const diagnostics: CorpusDiagnostic[] = [];
  const eligibilityBlockers: string[] = [];
  const rights = input.rightsById.get(input.corpusCase.rightsId);
  let rightsReview: CorpusCaseResult["rightsReview"] = "unavailable";
  let annotationReview: CorpusCaseResult["annotationReview"] = "unavailable";

  if (!rights) {
    diagnostics.push({
      code: "rights_record_missing",
      caseId: input.corpusCase.id,
      detail: `rights record ${input.corpusCase.rightsId} does not exist`,
    });
  } else {
    rightsReview = rights.reviewStatus;
    if (rights.sourceClass !== input.corpusCase.sourceClass) {
      diagnostics.push({
        code: "rights_source_class_mismatch",
        caseId: input.corpusCase.id,
        detail: `case declares ${input.corpusCase.sourceClass}; rights record declares ${rights.sourceClass}`,
      });
    }
    eligibilityBlockers.push(...getRightsEligibilityBlockers(rights, input.now));
    eligibilityBlockers.push(...validateCustomerRights(input.corpusCase, rights));
  }

  for (const artifact of input.corpusCase.artifacts) {
    try {
      await verifyReference({
        caseId: input.corpusCase.id,
        reference: artifact,
        roots: input.roots,
        diagnosticPrefix: artifact.role,
      });
    } catch (error) {
      diagnostics.push({
        code: "artifact_integrity_failed",
        caseId: input.corpusCase.id,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    const annotationPath = await verifyReference({
      caseId: input.corpusCase.id,
      reference: input.corpusCase.annotation,
      roots: input.roots,
      diagnosticPrefix: "annotation",
    });
    const annotationJson: unknown = JSON.parse(await fs.readFile(annotationPath, "utf8"));
    const annotationResult = manufacturingAnnotationSchema.safeParse(annotationJson);
    if (!annotationResult.success) {
      for (const diagnostic of formatZodDiagnostics(
        annotationResult.error,
        "annotation_schema_invalid",
      )) {
        diagnostics.push({
          ...diagnostic,
          caseId: input.corpusCase.id,
        });
      }
    } else {
      annotationReview = annotationResult.data.review.state;
      if (annotationResult.data.caseId !== input.corpusCase.id) {
        diagnostics.push({
          code: "annotation_case_mismatch",
          caseId: input.corpusCase.id,
          detail: `annotation belongs to ${annotationResult.data.caseId}`,
        });
      }
      if (annotationReview !== "approved") {
        eligibilityBlockers.push("annotation_review_pending");
      }
    }
  } catch (error) {
    diagnostics.push({
      code: "annotation_integrity_failed",
      caseId: input.corpusCase.id,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const totalArtifactBytes = input.corpusCase.artifacts.reduce(
    (sum, artifact) => sum + artifact.byteSize,
    0,
  );
  const exceedsSourceLimit = input.corpusCase.artifacts.some(
    (artifact) =>
      artifact.byteSize > input.corpusCase.executionLimits.maxSourceBytes,
  );
  const exceedsPackageLimit =
    totalArtifactBytes > input.corpusCase.executionLimits.maxPackageBytes;
  const expectsSourceOversizedFailure =
    input.corpusCase.expectedExecution.outcome === "bounded_failure" &&
    input.corpusCase.expectedExecution.diagnosticCodes.includes(
      "source_file_too_large",
    );
  const expectsPackageOversizedFailure =
    input.corpusCase.expectedExecution.outcome === "bounded_failure" &&
    input.corpusCase.expectedExecution.diagnosticCodes.includes(
      "package_too_large",
    );

  if (exceedsSourceLimit && !expectsSourceOversizedFailure) {
    diagnostics.push({
      code: "source_limit_exceeded_without_expected_failure",
      caseId: input.corpusCase.id,
      detail: `at least one artifact exceeds the ${input.corpusCase.executionLimits.maxSourceBytes}-byte source limit`,
    });
  }
  if (!exceedsSourceLimit && expectsSourceOversizedFailure) {
    diagnostics.push({
      code: "oversized_fixture_does_not_exceed_limit",
      caseId: input.corpusCase.id,
      detail: `no artifact exceeds the ${input.corpusCase.executionLimits.maxSourceBytes}-byte source limit`,
    });
  }
  if (exceedsPackageLimit && !expectsPackageOversizedFailure) {
    diagnostics.push({
      code: "package_limit_exceeded_without_expected_failure",
      caseId: input.corpusCase.id,
      detail: `declared artifacts total ${totalArtifactBytes} bytes; package limit is ${input.corpusCase.executionLimits.maxPackageBytes}`,
    });
  }
  if (!exceedsPackageLimit && expectsPackageOversizedFailure) {
    diagnostics.push({
      code: "package_fixture_does_not_exceed_limit",
      caseId: input.corpusCase.id,
      detail: `declared artifacts total ${totalArtifactBytes} bytes; package limit is ${input.corpusCase.executionLimits.maxPackageBytes}`,
    });
  }

  const integrityPassed = diagnostics.length === 0;
  return {
    result: {
      caseId: input.corpusCase.id,
      integrityPassed,
      annotationReview,
      rightsReview,
      eligibleForCoverage:
        integrityPassed && eligibilityBlockers.length === 0,
      eligibilityBlockers: [...new Set(eligibilityBlockers)].sort(stableCompare),
    } satisfies CorpusCaseResult,
    diagnostics,
  };
}

function buildCoverage(input: {
  manifest: ManufacturingCorpusManifest;
  caseResults: CorpusCaseResult[];
}) {
  const resultsById = new Map(
    input.caseResults.map((result) => [result.caseId, result]),
  );

  return input.manifest.targets
    .map((target): CorpusCoverageResult => {
      const presentCases = input.manifest.cases.filter(
        (corpusCase) =>
          corpusCase.supportTarget === target.supportTarget &&
          corpusCase.processFamilies.includes(target.processFamily),
      );
      const eligibleCases = presentCases.filter(
        (corpusCase) => resultsById.get(corpusCase.id)?.eligibleForCoverage,
      );
      const eligibleConsentedRealPackages = eligibleCases.filter(
        (corpusCase) => corpusCase.sourceClass === "consented_customer",
      ).length;
      const gapCodes: string[] = [];

      if (eligibleCases.length < target.minimumPackages) {
        gapCodes.push("minimum_packages_not_met");
      }
      if (
        eligibleConsentedRealPackages <
        target.minimumConsentedRealPackages
      ) {
        gapCodes.push("minimum_consented_real_packages_not_met");
      }

      return {
        processFamily: target.processFamily,
        supportTarget: target.supportTarget,
        minimumPackages: target.minimumPackages,
        eligiblePackages: eligibleCases.length,
        presentPackages: presentCases.length,
        minimumConsentedRealPackages:
          target.minimumConsentedRealPackages,
        eligibleConsentedRealPackages,
        promotionBlocked: gapCodes.length > 0,
        gapCodes,
      };
    })
    .sort((left, right) =>
      stableCompare(left.processFamily, right.processFamily),
    );
}

/**
 * Validates corpus schema, contained paths, immutable identities, annotations,
 * rights references, and promotion coverage without invoking production
 * extraction or pricing code.
 */
export async function validateManufacturingCorpus(
  options: ValidateManufacturingCorpusOptions,
): Promise<ManufacturingCorpusReport> {
  const manifestPath = path.resolve(options.manifestPath);
  let manifestText: string;
  try {
    manifestText = await fs.readFile(manifestPath, "utf8");
  } catch (error) {
    throw new CorpusContractError("Unable to read manufacturing corpus manifest", [
      {
        code: "manifest_unreadable",
        caseId: null,
        detail: error instanceof Error ? error.message : String(error),
      },
    ]);
  }

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestText);
  } catch (error) {
    throw new CorpusContractError("Manufacturing corpus manifest is malformed JSON", [
      {
        code: "manifest_json_invalid",
        caseId: null,
        detail: error instanceof Error ? error.message : String(error),
      },
    ]);
  }

  const manifestResult = corpusManifestSchema.safeParse(manifestJson);
  if (!manifestResult.success) {
    throw new CorpusContractError(
      "Manufacturing corpus manifest does not match its schema",
      sortDiagnostics(
        formatZodDiagnostics(manifestResult.error, "manifest_schema_invalid"),
      ),
    );
  }

  const manifest = manifestResult.data;
  const diagnostics = [
    ...assertUniqueIds(manifest.roots, "roots"),
    ...assertUniqueIds(manifest.rights, "rights"),
    ...assertUniqueIds(manifest.cases, "cases"),
  ];
  const targetKeys = new Set<string>();
  for (const target of manifest.targets) {
    const key = `${target.processFamily}:${target.supportTarget}`;
    if (targetKeys.has(key)) {
      diagnostics.push({
        code: "duplicate_target",
        caseId: null,
        detail: `targets contains duplicate ${key}`,
      });
    }
    targetKeys.add(key);
  }

  const manifestDirectory = path.dirname(manifestPath);
  const roots = resolveRoots(
    manifest,
    manifestDirectory,
    options.externalRoots ?? {},
  );
  const rightsById = new Map(
    manifest.rights.map((rights) => [rights.id, rights]),
  );
  const caseValidations = await Promise.all(
    manifest.cases.map((corpusCase) =>
      validateCase({
        corpusCase,
        rightsById,
        roots,
        now: options.now ?? new Date(),
      }),
    ),
  );

  for (const validation of caseValidations) {
    diagnostics.push(...validation.diagnostics);
  }

  const caseResults = caseValidations
    .map((validation) => validation.result)
    .sort((left, right) => stableCompare(left.caseId, right.caseId));
  const coverage = buildCoverage({ manifest, caseResults });

  return {
    schemaVersion: MANUFACTURING_BENCHMARK_RESULT_SCHEMA_VERSION,
    corpusSchemaVersion: MANUFACTURING_CORPUS_SCHEMA_VERSION,
    corpusVersion: manifest.corpusVersion,
    manifestSha256: createHash("sha256").update(manifestText).digest("hex"),
    integrityPassed: diagnostics.length === 0,
    caseResults,
    coverage,
    diagnostics: sortDiagnostics(diagnostics),
  };
}

/**
 * Builds the deterministic input plan supplied to a parser or geometry
 * dependency. Annotation paths, expected outputs, rights records, source
 * classifications, and process labels are intentionally excluded.
 */
export async function buildBlindedRunPlan(
  options: BuildBlindedRunPlanOptions,
): Promise<BlindedRunPlan> {
  const report = await validateManufacturingCorpus(options);
  if (!report.integrityPassed) {
    throw new CorpusContractError(
      "Cannot build a blinded run plan from an invalid corpus",
      report.diagnostics,
    );
  }

  const manifestPath = path.resolve(options.manifestPath);
  const manifestJson: unknown = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const manifest = corpusManifestSchema.parse(manifestJson);
  const eligibleIds = new Set(
    report.caseResults
      .filter((result) => result.eligibleForCoverage)
      .map((result) => result.caseId),
  );
  const caseResultsById = new Map(
    report.caseResults.map((result) => [result.caseId, result]),
  );
  const rightsById = new Map(
    manifest.rights.map((rights) => [rights.id, rights]),
  );
  const purpose = options.purpose ?? "geometry_sdk_evaluation";
  const processor = options.processor ?? "local";
  const includedCases: BlindedRunPlan["cases"] = [];
  const excludedCases: BlindedRunPlan["excludedCases"] = [];

  for (const corpusCase of manifest.cases) {
    const reasons = [
      ...(caseResultsById.get(corpusCase.id)?.eligibilityBlockers ?? []),
    ];
    const rights = rightsById.get(corpusCase.rightsId);
    if (!eligibleIds.has(corpusCase.id) && reasons.length === 0) {
      reasons.push("case_integrity_failed");
    }
    if (rights) {
      const permissionAllowed =
        purpose === "local_parser_evaluation"
          ? rights.permissions.localParserEvaluation
          : rights.permissions.geometrySdkEvaluation;
      if (!permissionAllowed) {
        reasons.push(`${purpose}_not_permitted`);
      }

      if (
        rights.processorPolicy.mode === "local_only" &&
        processor !== "local"
      ) {
        reasons.push("processor_not_permitted");
      }
      if (
        rights.processorPolicy.mode === "allowlist" &&
        !rights.processorPolicy.allowedProcessors.includes(processor)
      ) {
        reasons.push("processor_not_permitted");
      }
    }

    const uniqueReasons = [...new Set(reasons)].sort(stableCompare);
    if (uniqueReasons.length > 0) {
      excludedCases.push({
        caseId: corpusCase.id,
        reasonCodes: uniqueReasons,
      });
      continue;
    }

    includedCases.push({
      caseId: corpusCase.id,
      artifacts: [...corpusCase.artifacts].sort((left, right) =>
        stableCompare(
          `${left.role}:${left.rootId}:${left.path}`,
          `${right.role}:${right.rootId}:${right.path}`,
        ),
      ),
      executionLimits: corpusCase.executionLimits,
    });
  }

  return {
    schemaVersion: MANUFACTURING_BLIND_PLAN_SCHEMA_VERSION,
    corpusVersion: manifest.corpusVersion,
    manifestSha256: report.manifestSha256,
    purpose,
    processor,
    cases: includedCases.sort((left, right) =>
      stableCompare(left.caseId, right.caseId),
    ),
    excludedCases: excludedCases.sort((left, right) =>
      stableCompare(left.caseId, right.caseId),
    ),
  };
}

/**
 * Serializes benchmark outputs with a trailing newline for byte-stable
 * comparison in CI and third-party dependency evaluations.
 */
export function serializeManufacturingBenchmark(
  value: ManufacturingCorpusReport | BlindedRunPlan,
) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function isCorpusContractError(
  error: unknown,
): error is CorpusContractError {
  return error instanceof CorpusContractError;
}
