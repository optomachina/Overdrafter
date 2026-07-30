import { z } from "zod";
import {
  manufacturingCorpusOpaqueReferenceSchema,
  manufacturingCorpusPurposePermissionsSchema,
  manufacturingCorpusRedistributionLevelSchema,
  manufacturingCorpusSha256Schema,
  manufacturingCorpusSourceClassSchema,
  manufacturingCorpusStableIdSchema,
  manufacturingCorpusUtcTimestampSchema,
} from "./manufacturingCorpusVocabulary.js";

export const MANUFACTURING_CORPUS_RIGHTS_SCHEMA_VERSION =
  "manufacturing-corpus-rights.v1";

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
      approvedByRole: manufacturingCorpusStableIdSchema,
      approvedByRef: manufacturingCorpusOpaqueReferenceSchema,
      approvedAt: manufacturingCorpusUtcTimestampSchema,
    })
    .strict(),
]);

const governancePolicySchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("pending"),
      policyRef: manufacturingCorpusOpaqueReferenceSchema,
      policyVersion: z.null(),
      approvedByRef: z.null(),
      approvedAt: z.null(),
    })
    .strict(),
  z
    .object({
      status: z.literal("approved"),
      policyRef: manufacturingCorpusOpaqueReferenceSchema,
      policyVersion: z.string().trim().min(1),
      approvedByRef: manufacturingCorpusOpaqueReferenceSchema,
      approvedAt: manufacturingCorpusUtcTimestampSchema,
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
      tenantRef: manufacturingCorpusOpaqueReferenceSchema,
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
      revokedAt: manufacturingCorpusUtcTimestampSchema,
      reasonCode: manufacturingCorpusStableIdSchema,
      evidenceRef: manufacturingCorpusOpaqueReferenceSchema,
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
        requestRef: manufacturingCorpusOpaqueReferenceSchema,
        requestedAt: manufacturingCorpusUtcTimestampSchema,
        sourcePurgedAt: manufacturingCorpusUtcTimestampSchema.nullable(),
        derivedPurgedAt: manufacturingCorpusUtcTimestampSchema.nullable(),
        backupPurgedAt: manufacturingCorpusUtcTimestampSchema.nullable(),
        auditTombstoneRef:
          manufacturingCorpusOpaqueReferenceSchema.nullable(),
        purgeVerification: z
          .object({
            reference: manufacturingCorpusOpaqueReferenceSchema,
            verifiedByRef: manufacturingCorpusOpaqueReferenceSchema,
            verifiedAt: manufacturingCorpusUtcTimestampSchema,
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
        reference: manufacturingCorpusOpaqueReferenceSchema,
        effectiveAt: manufacturingCorpusUtcTimestampSchema,
      })
      .strict(),
    z
      .object({
        state: z.literal("released"),
        reference: manufacturingCorpusOpaqueReferenceSchema,
        effectiveAt: manufacturingCorpusUtcTimestampSchema,
        releasedAt: manufacturingCorpusUtcTimestampSchema,
        releaseRef: manufacturingCorpusOpaqueReferenceSchema,
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
    rightsId: manufacturingCorpusStableIdSchema,
    sourceClass: manufacturingCorpusSourceClassSchema,
    rightsBasisCode: manufacturingCorpusStableIdSchema,
    governance: governancePolicySchema,
    evidence: z
      .object({
        reference: manufacturingCorpusOpaqueReferenceSchema,
        sha256: manufacturingCorpusSha256Schema.nullable(),
        basisVersion: z.string().trim().min(1),
      })
      .strict(),
    approval: rightsApprovalSchema,
    validity: z
      .object({
        effectiveAt: manufacturingCorpusUtcTimestampSchema.nullable(),
        expiresAt: manufacturingCorpusUtcTimestampSchema.nullable(),
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
        policyRef: manufacturingCorpusOpaqueReferenceSchema,
        sourceExpiresAt: manufacturingCorpusUtcTimestampSchema.nullable(),
        derivedExpiresAt: manufacturingCorpusUtcTimestampSchema.nullable(),
        backupExpiresAt: manufacturingCorpusUtcTimestampSchema.nullable(),
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

export type ManufacturingCorpusRights = z.infer<
  typeof manufacturingCorpusRightsSchema
>;
