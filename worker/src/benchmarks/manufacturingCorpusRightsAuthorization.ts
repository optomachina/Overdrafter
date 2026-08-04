import { z } from "zod";
import { manufacturingCorpusPurposePermissionsSchema } from "./manufacturingCorpusPurposePermissions.js";
import {
  manufacturingCorpusOpaqueReferenceSchema,
  manufacturingCorpusRedistributionLevelSchema,
  manufacturingCorpusSha256Schema,
  manufacturingCorpusSourceClassSchema,
  manufacturingCorpusStableIdSchema,
  manufacturingCorpusUtcTimestampSchema,
} from "./manufacturingCorpusVocabulary.js";

const manufacturingCorpusRightsApprovalSchema = z.discriminatedUnion(
  "status",
  [
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
  ],
);

const manufacturingCorpusGovernancePolicySchema = z.discriminatedUnion(
  "status",
  [
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
  ],
);

const manufacturingCorpusTenantScopeSchema = z.discriminatedUnion("kind", [
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

const manufacturingCorpusRightsEvidenceSchema = z
  .object({
    reference: manufacturingCorpusOpaqueReferenceSchema,
    sha256: manufacturingCorpusSha256Schema.nullable(),
    basisVersion: z.string().trim().min(1),
  })
  .strict();

const manufacturingCorpusRightsValiditySchema = z
  .object({
    effectiveAt: manufacturingCorpusUtcTimestampSchema.nullable(),
    expiresAt: manufacturingCorpusUtcTimestampSchema.nullable(),
  })
  .strict();

const manufacturingCorpusRightsRedistributionSchema = z
  .object({
    assets: manufacturingCorpusRedistributionLevelSchema,
    annotations: manufacturingCorpusRedistributionLevelSchema,
    derivedOutputs: manufacturingCorpusRedistributionLevelSchema,
  })
  .strict();

const manufacturingCorpusRightsRetentionSchema = z
  .object({
    policyRef: manufacturingCorpusOpaqueReferenceSchema,
    sourceExpiresAt: manufacturingCorpusUtcTimestampSchema.nullable(),
    derivedExpiresAt: manufacturingCorpusUtcTimestampSchema.nullable(),
    backupExpiresAt: manufacturingCorpusUtcTimestampSchema.nullable(),
  })
  .strict();

/**
 * Internal field bindings shared with the final rights-record composition.
 * Consumers must preserve these exact schema instances instead of recreating
 * authorization semantics.
 *
 * @internal
 */
export const manufacturingCorpusRightsAuthorizationFieldSchemas = {
  sourceClass: manufacturingCorpusSourceClassSchema,
  governance: manufacturingCorpusGovernancePolicySchema,
  evidence: manufacturingCorpusRightsEvidenceSchema,
  approval: manufacturingCorpusRightsApprovalSchema,
  validity: manufacturingCorpusRightsValiditySchema,
  tenantScope: manufacturingCorpusTenantScopeSchema,
  permissions: manufacturingCorpusPurposePermissionsSchema,
  redistribution: manufacturingCorpusRightsRedistributionSchema,
  retention: manufacturingCorpusRightsRetentionSchema,
} as const;

export type ManufacturingCorpusRightsAuthorizationFields = z.infer<
  z.ZodObject<typeof manufacturingCorpusRightsAuthorizationFieldSchemas>
>;

/**
 * Applies the cross-field authorization invariants used by both this focused
 * schema and the final flat rights record.
 *
 * @internal
 */
export function applyManufacturingCorpusRightsAuthorizationRefinements(
  authorization: ManufacturingCorpusRightsAuthorizationFields,
  context: z.RefinementCtx,
): void {
  if (
    authorization.approval.status === "approved" &&
    authorization.governance.status !== "approved"
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["governance", "status"],
      message: "must be approved before rights approval",
    });
  }

  if (
    authorization.approval.status === "approved" &&
    authorization.governance.status === "approved" &&
    Date.parse(authorization.approval.approvedAt) <
      Date.parse(authorization.governance.approvedAt)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["approval", "approvedAt"],
      message: "must not precede governance approval",
    });
  }

  if (
    authorization.approval.status === "approved" &&
    authorization.validity.effectiveAt === null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["validity", "effectiveAt"],
      message: "is required when rights are approved",
    });
  }

  if (
    authorization.approval.status === "pending" &&
    authorization.validity.effectiveAt !== null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["validity", "effectiveAt"],
      message: "must be null while rights approval is pending",
    });
  }

  if (
    authorization.validity.effectiveAt === null &&
    authorization.validity.expiresAt !== null
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["validity", "expiresAt"],
      message: "requires an effectiveAt timestamp",
    });
  }

  if (
    authorization.validity.effectiveAt !== null &&
    authorization.validity.expiresAt !== null &&
    Date.parse(authorization.validity.expiresAt) <=
      Date.parse(authorization.validity.effectiveAt)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["validity", "expiresAt"],
      message: "must be later than effectiveAt",
    });
  }

  if (authorization.sourceClass !== "consented_customer") {
    return;
  }

  if (authorization.evidence.sha256 === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence", "sha256"],
      message: "is required for consented customer data",
    });
  }
  if (authorization.tenantScope.kind !== "single_tenant") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["tenantScope"],
      message: "must identify exactly one tenant for consented customer data",
    });
  }
}

/**
 * Strict internal authorization boundary for manufacturing-corpus rights.
 *
 * @internal
 */
export const manufacturingCorpusRightsAuthorizationSchema = z
  .object(manufacturingCorpusRightsAuthorizationFieldSchemas)
  .strict()
  .superRefine(applyManufacturingCorpusRightsAuthorizationRefinements);

export type ManufacturingCorpusRightsAuthorization = z.infer<
  typeof manufacturingCorpusRightsAuthorizationSchema
>;
