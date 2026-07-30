import { z } from "zod";

export const MANUFACTURING_CORPUS_MANIFEST_SCHEMA_VERSION =
  "manufacturing-corpus-manifest.v1";
export const MANUFACTURING_CORPUS_ANNOTATION_SCHEMA_VERSION =
  "manufacturing-corpus-annotation.v1";
export const MANUFACTURING_CORPUS_RIGHTS_SCHEMA_VERSION =
  "manufacturing-corpus-rights.v1";
export const MANUFACTURING_CORPUS_ROOT_SCHEMA_VERSION =
  "manufacturing-corpus-root.v1";
export const MANUFACTURING_CORPUS_CASE_SCHEMA_VERSION =
  "manufacturing-corpus-case.v1";
export const MANUFACTURING_CORPUS_TARGET_SCHEMA_VERSION =
  "manufacturing-corpus-target.v1";

export const MANUFACTURING_PROCESS_FAMILIES = [
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
] as const;

export const MANUFACTURING_QUALIFICATION_TARGETS = [
  "characterization_only",
  "broad_estimate",
] as const;

export const MANUFACTURING_CORPUS_PERMISSION_PURPOSES = [
  "humanAnnotation",
  "localParserEvaluation",
  "geometrySdkEvaluation",
  "modelValidation",
  "modelTraining",
  "commercialProductImprovement",
  "internalDemonstration",
  "publication",
  "quoteOutcomeUse",
  "benchmarkRetention",
] as const;

export const manufacturingProcessFamilySchema = z.enum(
  MANUFACTURING_PROCESS_FAMILIES,
);
export const manufacturingQualificationTargetSchema = z.enum(
  MANUFACTURING_QUALIFICATION_TARGETS,
);
export const manufacturingCorpusPermissionPurposeSchema = z.enum(
  MANUFACTURING_CORPUS_PERMISSION_PURPOSES,
);

export const manufacturingCorpusSourceClassSchema = z.enum([
  "synthetic",
  "public_standard",
  "open_license",
  "company_owned",
  "consented_customer",
]);

export const manufacturingCorpusArtifactClassSchema = z.enum([
  "cad_model",
  "drawing",
  "bom",
  "annotation",
  "quote_outcome",
  "other",
]);

export const manufacturingCorpusDataClassificationSchema = z.enum([
  "public",
  "internal",
  "confidential",
  "controlled",
]);

export const manufacturingCorpusRedistributionLevelSchema = z.enum([
  "internal_only",
  "metadata_only",
  "derived_noninvertible",
  "full_assets",
]);

const stableIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "must be a stable lowercase identifier");
const opaqueReferenceSchema = z.string().trim().min(1).max(512);
const sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "must be a lowercase SHA-256 digest");
const utcTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine(
    (value) => value.endsWith("Z"),
    "must be a UTC timestamp ending in Z",
  );

type JsonValue =
  boolean | number | string | null | JsonValue[] | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

function isPortableRelativePath(value: string) {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    /^[A-Za-z]:/.test(value)
  ) {
    return false;
  }

  return value
    .split("/")
    .every(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    );
}

function hasDuplicates(values: readonly string[]) {
  return new Set(values).size !== values.length;
}

export const portableRelativeFilePathSchema = z
  .string()
  .refine(
    isPortableRelativePath,
    "must be a portable contained relative file path",
  );

export const portableRelativeRootPathSchema = z
  .string()
  .refine(
    (value) => value === "." || isPortableRelativePath(value),
    "must be '.' or a portable contained relative directory path",
  );

const processorPolicySchema = z
  .object({
    executionLocation: z.enum(["local_only", "approved_service"]),
    allowedProcessors: z.array(stableIdSchema),
    rawOutputRetentionAllowed: z.boolean(),
  })
  .strict()
  .superRefine((policy, context) => {
    if (hasDuplicates(policy.allowedProcessors)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowedProcessors"],
        message: "must not contain duplicate processor identifiers",
      });
    }
  });

export const manufacturingCorpusPermissionGrantSchema = z
  .object({
    allowed: z.boolean(),
    artifactClasses: z.array(manufacturingCorpusArtifactClassSchema),
    processorPolicy: processorPolicySchema,
  })
  .strict()
  .superRefine((grant, context) => {
    if (hasDuplicates(grant.artifactClasses)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifactClasses"],
        message: "must not contain duplicate artifact classes",
      });
    }
    if (!grant.allowed) {
      if (grant.artifactClasses.length > 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["artifactClasses"],
          message: "must be empty when the purpose is denied",
        });
      }
      if (
        grant.processorPolicy.executionLocation !== "local_only" ||
        grant.processorPolicy.allowedProcessors.length > 0 ||
        grant.processorPolicy.rawOutputRetentionAllowed
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["processorPolicy"],
          message: "must remain local-only with no retained output when denied",
        });
      }
      return;
    }

    if (grant.artifactClasses.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifactClasses"],
        message: "must include at least one artifact class when allowed",
      });
    }
    if (grant.processorPolicy.allowedProcessors.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["processorPolicy", "allowedProcessors"],
        message: "must name at least one authorized processor when allowed",
      });
    }
  });

export const manufacturingCorpusPurposePermissionsSchema = z
  .object({
    humanAnnotation: manufacturingCorpusPermissionGrantSchema,
    localParserEvaluation: manufacturingCorpusPermissionGrantSchema,
    geometrySdkEvaluation: manufacturingCorpusPermissionGrantSchema,
    modelValidation: manufacturingCorpusPermissionGrantSchema,
    modelTraining: manufacturingCorpusPermissionGrantSchema,
    commercialProductImprovement: manufacturingCorpusPermissionGrantSchema,
    internalDemonstration: manufacturingCorpusPermissionGrantSchema,
    publication: manufacturingCorpusPermissionGrantSchema,
    quoteOutcomeUse: manufacturingCorpusPermissionGrantSchema,
    benchmarkRetention: manufacturingCorpusPermissionGrantSchema,
  })
  .strict();

export type ManufacturingCorpusPermissionGrant = z.infer<
  typeof manufacturingCorpusPermissionGrantSchema
>;
export type ManufacturingCorpusPurposePermissions = z.infer<
  typeof manufacturingCorpusPurposePermissionsSchema
>;

type DeepReadonly<T> = T extends readonly unknown[]
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

/** Creates a mutable, independent deny-all declaration for corpus examples. */
export function createDefaultDenyManufacturingCorpusPermissions(): ManufacturingCorpusPurposePermissions {
  const deny = (): ManufacturingCorpusPermissionGrant => ({
    allowed: false,
    artifactClasses: [],
    processorPolicy: {
      executionLocation: "local_only",
      allowedProcessors: [],
      rawOutputRetentionAllowed: false,
    },
  });
  return {
    humanAnnotation: deny(),
    localParserEvaluation: deny(),
    geometrySdkEvaluation: deny(),
    modelValidation: deny(),
    modelTraining: deny(),
    commercialProductImprovement: deny(),
    internalDemonstration: deny(),
    publication: deny(),
    quoteOutcomeUse: deny(),
    benchmarkRetention: deny(),
  };
}

export const DEFAULT_DENY_MANUFACTURING_CORPUS_PERMISSIONS = deepFreeze(
  createDefaultDenyManufacturingCorpusPermissions(),
);

const rightsApprovalSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("pending"),
      approvedByRole: z.null(),
      approvedByRef: z.null(),
      approvedAt: z.null(),
    })
    .strict(),
  z
    .object({
      status: z.literal("approved"),
      approvedByRole: stableIdSchema,
      approvedByRef: opaqueReferenceSchema,
      approvedAt: utcTimestampSchema,
    })
    .strict(),
]);

const governancePolicySchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("pending"),
      policyRef: opaqueReferenceSchema,
      policyVersion: z.null(),
      approvedByRef: z.null(),
      approvedAt: z.null(),
    })
    .strict(),
  z
    .object({
      status: z.literal("approved"),
      policyRef: opaqueReferenceSchema,
      policyVersion: z.string().trim().min(1),
      approvedByRef: opaqueReferenceSchema,
      approvedAt: utcTimestampSchema,
    })
    .strict(),
]);

const tenantScopeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("none"),
      crossTenantUse: z.literal(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal("single_tenant"),
      tenantRef: opaqueReferenceSchema,
      crossTenantUse: z.literal(false),
    })
    .strict(),
]);

const rightsRevocationSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("active"),
      revokedAt: z.null(),
      reasonCode: z.null(),
      evidenceRef: z.null(),
    })
    .strict(),
  z
    .object({
      state: z.literal("revoked"),
      revokedAt: utcTimestampSchema,
      reasonCode: stableIdSchema,
      evidenceRef: opaqueReferenceSchema,
    })
    .strict(),
]);

const rightsDeletionSchema = z
  .discriminatedUnion("state", [
    z
      .object({
        state: z.literal("none"),
        requestRef: z.null(),
        requestedAt: z.null(),
        sourcePurgedAt: z.null(),
        derivedPurgedAt: z.null(),
        backupPurgedAt: z.null(),
        auditTombstoneRef: z.null(),
        purgeVerification: z.null(),
      })
      .strict(),
    z
      .object({
        state: z.literal("requested"),
        requestRef: opaqueReferenceSchema,
        requestedAt: utcTimestampSchema,
        sourcePurgedAt: utcTimestampSchema.nullable(),
        derivedPurgedAt: utcTimestampSchema.nullable(),
        backupPurgedAt: utcTimestampSchema.nullable(),
        auditTombstoneRef: opaqueReferenceSchema.nullable(),
        purgeVerification: z
          .object({
            reference: opaqueReferenceSchema,
            verifiedByRef: opaqueReferenceSchema,
            verifiedAt: utcTimestampSchema,
          })
          .strict()
          .nullable(),
      })
      .strict(),
  ])
  .superRefine((deletion, context) => {
    if (deletion.state !== "requested") {
      return;
    }
    const requestedAt = Date.parse(deletion.requestedAt);
    for (const [field, value] of [
      ["sourcePurgedAt", deletion.sourcePurgedAt],
      ["derivedPurgedAt", deletion.derivedPurgedAt],
      ["backupPurgedAt", deletion.backupPurgedAt],
    ] as const) {
      if (value !== null && Date.parse(value) < requestedAt) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: "must not precede the deletion request",
        });
      }
    }
    const hasCompletedPurge = [
      deletion.sourcePurgedAt,
      deletion.derivedPurgedAt,
      deletion.backupPurgedAt,
    ].some((value) => value !== null);
    if (hasCompletedPurge && deletion.purgeVerification === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["purgeVerification"],
        message: "is required when a purge timestamp is recorded",
      });
    }
    if (!hasCompletedPurge && deletion.purgeVerification !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["purgeVerification"],
        message: "must be null until at least one purge is recorded",
      });
    }
    if (
      deletion.purgeVerification !== null &&
      Date.parse(deletion.purgeVerification.verifiedAt) < requestedAt
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["purgeVerification", "verifiedAt"],
        message: "must not precede the deletion request",
      });
    }
    if (deletion.purgeVerification !== null) {
      const latestPurge = Math.max(
        ...[
          deletion.sourcePurgedAt,
          deletion.derivedPurgedAt,
          deletion.backupPurgedAt,
        ]
          .filter((value): value is string => value !== null)
          .map(Date.parse),
      );
      if (Date.parse(deletion.purgeVerification.verifiedAt) < latestPurge) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["purgeVerification", "verifiedAt"],
          message: "must not precede a recorded purge",
        });
      }
    }
  });

const rightsLegalHoldSchema = z
  .discriminatedUnion("state", [
    z
      .object({
        state: z.literal("inactive"),
        reference: z.null(),
        effectiveAt: z.null(),
      })
      .strict(),
    z
      .object({
        state: z.literal("active"),
        reference: opaqueReferenceSchema,
        effectiveAt: utcTimestampSchema,
      })
      .strict(),
    z
      .object({
        state: z.literal("released"),
        reference: opaqueReferenceSchema,
        effectiveAt: utcTimestampSchema,
        releasedAt: utcTimestampSchema,
        releaseRef: opaqueReferenceSchema,
      })
      .strict(),
  ])
  .superRefine((hold, context) => {
    if (
      hold.state === "released" &&
      Date.parse(hold.releasedAt) < Date.parse(hold.effectiveAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["releasedAt"],
        message: "must not precede effectiveAt",
      });
    }
  });

export const manufacturingCorpusRightsSchema = z
  .object({
    schemaVersion: z.literal(MANUFACTURING_CORPUS_RIGHTS_SCHEMA_VERSION),
    rightsId: stableIdSchema,
    sourceClass: manufacturingCorpusSourceClassSchema,
    rightsBasisCode: stableIdSchema,
    governance: governancePolicySchema,
    evidence: z
      .object({
        reference: opaqueReferenceSchema,
        sha256: sha256Schema.nullable(),
        basisVersion: z.string().trim().min(1),
      })
      .strict(),
    approval: rightsApprovalSchema,
    validity: z
      .object({
        effectiveAt: utcTimestampSchema.nullable(),
        expiresAt: utcTimestampSchema.nullable(),
      })
      .strict(),
    tenantScope: tenantScopeSchema,
    permissions: manufacturingCorpusPurposePermissionsSchema,
    redistribution: z
      .object({
        assets: manufacturingCorpusRedistributionLevelSchema,
        annotations: manufacturingCorpusRedistributionLevelSchema,
        derivedOutputs: manufacturingCorpusRedistributionLevelSchema,
      })
      .strict(),
    retention: z
      .object({
        policyRef: opaqueReferenceSchema,
        sourceExpiresAt: utcTimestampSchema.nullable(),
        derivedExpiresAt: utcTimestampSchema.nullable(),
        backupExpiresAt: utcTimestampSchema.nullable(),
      })
      .strict(),
    revocation: rightsRevocationSchema,
    deletion: rightsDeletionSchema,
    legalHold: rightsLegalHoldSchema,
  })
  .strict()
  .superRefine((rights, context) => {
    if (
      rights.approval.status === "approved" &&
      rights.governance.status !== "approved"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["governance", "status"],
        message: "must be approved before rights approval",
      });
    }
    if (
      rights.approval.status === "approved" &&
      rights.governance.status === "approved" &&
      Date.parse(rights.approval.approvedAt) <
        Date.parse(rights.governance.approvedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["approval", "approvedAt"],
        message: "must not precede governance approval",
      });
    }
    if (
      rights.approval.status === "approved" &&
      rights.validity.effectiveAt === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["validity", "effectiveAt"],
        message: "is required when rights are approved",
      });
    }
    if (
      rights.approval.status === "pending" &&
      rights.validity.effectiveAt !== null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["validity", "effectiveAt"],
        message: "must be null while rights approval is pending",
      });
    }
    if (
      rights.validity.effectiveAt !== null &&
      rights.validity.expiresAt !== null &&
      Date.parse(rights.validity.expiresAt) <=
        Date.parse(rights.validity.effectiveAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["validity", "expiresAt"],
        message: "must be later than effectiveAt",
      });
    }
    if (rights.deletion.state === "requested") {
      const purgeTimestamps = [
        rights.deletion.sourcePurgedAt,
        rights.deletion.derivedPurgedAt,
        rights.deletion.backupPurgedAt,
      ].filter((value): value is string => value !== null);
      if (rights.legalHold.state === "active" && purgeTimestamps.length > 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["deletion"],
          message: "must not record purges while a legal hold is active",
        });
      }
      if (rights.legalHold.state === "released") {
        const holdStart = Date.parse(rights.legalHold.effectiveAt);
        const holdEnd = Date.parse(rights.legalHold.releasedAt);
        if (
          purgeTimestamps.some((timestamp) => {
            const purgeTime = Date.parse(timestamp);
            return purgeTime >= holdStart && purgeTime < holdEnd;
          })
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["deletion"],
            message: "must not record purges during a legal hold",
          });
        }
      }
    }
    if (rights.sourceClass === "consented_customer") {
      if (rights.evidence.sha256 === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["evidence", "sha256"],
          message: "is required for consented customer data",
        });
      }
      if (rights.tenantScope.kind !== "single_tenant") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tenantScope"],
          message:
            "must identify exactly one tenant for consented customer data",
        });
      }
    }
  });

const corpusRootBaseShape = {
  schemaVersion: z.literal(MANUFACTURING_CORPUS_ROOT_SCHEMA_VERSION),
  rootId: stableIdSchema,
};

export const manufacturingCorpusRootSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...corpusRootBaseShape,
      kind: z.literal("manifest_relative"),
      relativePath: portableRelativeRootPathSchema,
      accessClass: z.literal("redistributable"),
      allowedDataClassifications: z.array(z.literal("public")).length(1),
    })
    .strict(),
  z
    .object({
      ...corpusRootBaseShape,
      kind: z.literal("external_mount"),
      accessClass: z.literal("internal_only"),
      allowedDataClassifications: z
        .array(manufacturingCorpusDataClassificationSchema)
        .min(1)
        .refine(
          (values) => !hasDuplicates(values),
          "must not contain duplicate data classifications",
        ),
    })
    .strict(),
]);

export const manufacturingCorpusArtifactSchema = z
  .object({
    artifactId: stableIdSchema,
    artifactClass: manufacturingCorpusArtifactClassSchema,
    rootId: stableIdSchema,
    relativePath: portableRelativeFilePathSchema,
    mediaType: z
      .string()
      .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i),
    byteSize: z.number().int().nonnegative().safe(),
    sha256: sha256Schema,
  })
  .strict();

const manufacturingCorpusAnnotationArtifactSchema =
  manufacturingCorpusArtifactSchema.extend({
    artifactClass: z.literal("annotation"),
  });

export const manufacturingCorpusTargetSchema = z
  .object({
    schemaVersion: z.literal(MANUFACTURING_CORPUS_TARGET_SCHEMA_VERSION),
    processFamily: manufacturingProcessFamilySchema,
    qualificationTarget: manufacturingQualificationTargetSchema,
    minimumPackages: z.number().int().nonnegative().safe(),
    minimumConsentedRealPackages: z.number().int().nonnegative().safe(),
  })
  .strict()
  .superRefine((target, context) => {
    if (target.minimumConsentedRealPackages > target.minimumPackages) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["minimumConsentedRealPackages"],
        message: "must not exceed minimumPackages",
      });
    }
  });

const redactionDeclarationSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("not_required"),
      reviewRef: z.null(),
    })
    .strict(),
  z
    .object({
      state: z.literal("pending"),
      reviewRef: opaqueReferenceSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("verified"),
      reviewRef: opaqueReferenceSchema,
    })
    .strict(),
]);

const executionLimitsSchema = z
  .object({
    maxSourceBytes: z.number().int().positive().safe(),
    maxPackageBytes: z.number().int().positive().safe(),
    maxOutputBytes: z.number().int().positive().safe(),
    maxRecursionDepth: z.number().int().positive().safe(),
    timeoutMs: z.number().int().positive().safe(),
    memoryMb: z.number().int().positive().safe(),
  })
  .strict()
  .superRefine((limits, context) => {
    if (limits.maxPackageBytes < limits.maxSourceBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["maxPackageBytes"],
        message: "must be greater than or equal to maxSourceBytes",
      });
    }
  });

export const manufacturingCorpusCaseSchema = z
  .object({
    schemaVersion: z.literal(MANUFACTURING_CORPUS_CASE_SCHEMA_VERSION),
    caseId: stableIdSchema,
    processFamilies: z.array(manufacturingProcessFamilySchema).min(1),
    qualificationTarget: manufacturingQualificationTargetSchema,
    sourceClass: manufacturingCorpusSourceClassSchema,
    dataClassification: manufacturingCorpusDataClassificationSchema,
    redaction: redactionDeclarationSchema,
    protectedSourceRef: opaqueReferenceSchema,
    rightsId: stableIdSchema,
    artifacts: z.array(manufacturingCorpusArtifactSchema).min(1),
    annotationArtifact: manufacturingCorpusAnnotationArtifactSchema,
    executionLimits: executionLimitsSchema,
  })
  .strict()
  .superRefine((corpusCase, context) => {
    if (hasDuplicates(corpusCase.processFamilies)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["processFamilies"],
        message: "must not contain duplicate process families",
      });
    }
    if (
      corpusCase.artifacts.some(
        (artifact) => artifact.artifactClass === "annotation",
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifacts"],
        message: "must not contain the protected annotation artifact",
      });
    }
  });

const annotationEvidenceSchema = z
  .object({
    artifactId: stableIdSchema,
    locator: z.string().trim().min(1),
  })
  .strict();

const expectedCountSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("known"),
      value: z.number().int().nonnegative().safe(),
      evidence: z.array(annotationEvidenceSchema).min(1),
    })
    .strict(),
  z
    .object({
      state: z.literal("unsupported"),
      reasonCode: stableIdSchema,
      evidence: z.array(annotationEvidenceSchema).min(1),
    })
    .strict(),
  z
    .object({
      state: z.literal("not_applicable"),
      reasonCode: stableIdSchema,
      evidence: z.array(annotationEvidenceSchema).min(1),
    })
    .strict(),
  z
    .object({
      state: z.literal("parse_failed"),
      reasonCode: stableIdSchema,
      evidence: z.array(annotationEvidenceSchema).min(1),
    })
    .strict(),
]);

const expectedLengthUnitSchema = z.union([
  z
    .object({
      state: z.literal("known"),
      value: z.enum(["mm", "in"]),
      evidence: z.array(annotationEvidenceSchema).min(1),
    })
    .strict(),
  z
    .object({
      state: z.enum(["missing", "unsupported", "conflicting", "parse_failed"]),
      reasonCode: stableIdSchema,
      evidence: z.array(annotationEvidenceSchema).min(1),
    })
    .strict(),
]);

const expectedExecutionSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("success"),
      diagnosticCodes: z.array(stableIdSchema).length(0),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("bounded_failure"),
      diagnosticCodes: z.array(stableIdSchema).min(1),
    })
    .strict(),
]);

const annotationReviewSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("pending_manufacturing_review"),
      reviewerRole: z.null(),
      reviewerRef: z.null(),
      reviewedAt: z.null(),
      reviewRef: z.null(),
      reviewPolicyVersion: z.null(),
    })
    .strict(),
  z
    .object({
      state: z.literal("approved"),
      reviewerRole: stableIdSchema,
      reviewerRef: opaqueReferenceSchema,
      reviewedAt: utcTimestampSchema,
      reviewRef: opaqueReferenceSchema,
      reviewPolicyVersion: z.string().trim().min(1),
    })
    .strict(),
]);

export const manufacturingCorpusAnnotationSchema = z
  .object({
    schemaVersion: z.literal(MANUFACTURING_CORPUS_ANNOTATION_SCHEMA_VERSION),
    annotationRevision: z.string().trim().min(1),
    caseId: stableIdSchema,
    review: annotationReviewSchema,
    expected: z
      .object({
        productStructure: z
          .object({
            definitionCount: expectedCountSchema,
            occurrenceCount: expectedCountSchema,
          })
          .strict(),
        units: z
          .object({
            length: expectedLengthUnitSchema,
          })
          .strict(),
        commonFeatures: z.array(
          z
            .object({
              label: stableIdSchema,
              count: z.number().int().nonnegative().safe(),
              parameters: z.record(jsonValueSchema),
              evidence: z.array(annotationEvidenceSchema).min(1),
            })
            .strict(),
        ),
        requirements: z.array(
          z
            .object({
              key: stableIdSchema,
              value: jsonValueSchema,
              unit: z.string().trim().min(1).nullable(),
              governing: z.boolean(),
              evidence: z.array(annotationEvidenceSchema).min(1),
            })
            .strict(),
        ),
        candidateRoutes: z.array(
          z
            .object({
              processFamily: manufacturingProcessFamilySchema,
              state: z.enum(["applicable", "possible", "excluded"]),
              evidence: z.array(annotationEvidenceSchema).min(1),
            })
            .strict(),
        ),
        unsupportedStates: z.array(
          z
            .object({
              code: stableIdSchema,
              evidence: z.array(annotationEvidenceSchema).min(1),
            })
            .strict(),
        ),
        execution: expectedExecutionSchema,
      })
      .strict(),
  })
  .strict();

export const manufacturingCorpusManifestSchema = z
  .object({
    schemaVersion: z.literal(MANUFACTURING_CORPUS_MANIFEST_SCHEMA_VERSION),
    manifestClass: z.literal("protected_internal"),
    corpusVersion: z.string().trim().min(1),
    roots: z.array(manufacturingCorpusRootSchema).min(1),
    rights: z.array(manufacturingCorpusRightsSchema),
    targets: z.array(manufacturingCorpusTargetSchema).min(1),
    cases: z.array(manufacturingCorpusCaseSchema),
  })
  .strict()
  .superRefine((manifest, context) => {
    manifest.cases.forEach((corpusCase, caseIndex) => {
      const matchingRights = manifest.rights.filter(
        (rights) => rights.rightsId === corpusCase.rightsId,
      );
      if (matchingRights.length !== 1) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cases", caseIndex, "rightsId"],
          message: "must reference exactly one rights record",
        });
        return;
      }
      if (matchingRights[0].sourceClass !== corpusCase.sourceClass) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cases", caseIndex, "sourceClass"],
          message: "must match the referenced rights source class",
        });
      }
    });
  });

export type ManufacturingProcessFamily = z.infer<
  typeof manufacturingProcessFamilySchema
>;
export type ManufacturingQualificationTarget = z.infer<
  typeof manufacturingQualificationTargetSchema
>;
export type ManufacturingCorpusRights = z.infer<
  typeof manufacturingCorpusRightsSchema
>;
export type ManufacturingCorpusRoot = z.infer<
  typeof manufacturingCorpusRootSchema
>;
export type ManufacturingCorpusArtifact = z.infer<
  typeof manufacturingCorpusArtifactSchema
>;
export type ManufacturingCorpusTarget = z.infer<
  typeof manufacturingCorpusTargetSchema
>;
export type ManufacturingCorpusCase = z.infer<
  typeof manufacturingCorpusCaseSchema
>;
export type ManufacturingCorpusAnnotation = z.infer<
  typeof manufacturingCorpusAnnotationSchema
>;
export type ManufacturingCorpusManifest = z.infer<
  typeof manufacturingCorpusManifestSchema
>;
