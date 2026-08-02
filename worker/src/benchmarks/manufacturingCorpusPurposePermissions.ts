import { z } from "zod";
import {
  manufacturingCorpusArtifactClassSchema,
  manufacturingCorpusHasDuplicates,
  manufacturingCorpusStableIdSchema,
} from "./manufacturingCorpusVocabulary.js";

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

export const MANUFACTURING_CORPUS_PROCESSOR_EXECUTION_LOCATIONS = [
  "local_only",
  "approved_service",
] as const;

export const manufacturingCorpusPermissionPurposeSchema = z.enum(
  MANUFACTURING_CORPUS_PERMISSION_PURPOSES,
);
export const manufacturingCorpusProcessorExecutionLocationSchema = z.enum(
  MANUFACTURING_CORPUS_PROCESSOR_EXECUTION_LOCATIONS,
);

const manufacturingCorpusProcessorPolicySchema = z
  .object({
    executionLocation: manufacturingCorpusProcessorExecutionLocationSchema,
    allowedProcessors: z.array(manufacturingCorpusStableIdSchema),
    rawOutputRetentionAllowed: z.boolean(),
  })
  .strict()
  .superRefine((policy, context) => {
    if (manufacturingCorpusHasDuplicates(policy.allowedProcessors)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["allowedProcessors"],
        message: "must not contain duplicate processor identifiers",
      });
    }
  });

/**
 * Validates one purpose grant using fail-closed security invariants. Denied
 * grants cannot authorize artifacts, service execution, processors, or raw
 * output retention; allowed grants must name artifacts and exact processors.
 */
export const manufacturingCorpusPermissionGrantSchema = z
  .object({
    allowed: z.boolean(),
    artifactClasses: z.array(manufacturingCorpusArtifactClassSchema),
    processorPolicy: manufacturingCorpusProcessorPolicySchema,
  })
  .strict()
  .superRefine((grant, context) => {
    if (manufacturingCorpusHasDuplicates(grant.artifactClasses)) {
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
      if (grant.processorPolicy.executionLocation !== "local_only") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["processorPolicy", "executionLocation"],
          message: "must remain local-only when the purpose is denied",
        });
      }
      if (grant.processorPolicy.allowedProcessors.length > 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["processorPolicy", "allowedProcessors"],
          message: "must be empty when the purpose is denied",
        });
      }
      if (grant.processorPolicy.rawOutputRetentionAllowed) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["processorPolicy", "rawOutputRetentionAllowed"],
          message: "must be false when the purpose is denied",
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

export type ManufacturingCorpusPermissionPurpose = z.infer<
  typeof manufacturingCorpusPermissionPurposeSchema
>;
export type ManufacturingCorpusProcessorExecutionLocation = z.infer<
  typeof manufacturingCorpusProcessorExecutionLocationSchema
>;
export type ManufacturingCorpusProcessorPolicy = z.infer<
  typeof manufacturingCorpusProcessorPolicySchema
>;
export type ManufacturingCorpusPermissionGrant = z.infer<
  typeof manufacturingCorpusPermissionGrantSchema
>;

const manufacturingCorpusPurposePermissionShape = {
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
} satisfies Record<
  ManufacturingCorpusPermissionPurpose,
  typeof manufacturingCorpusPermissionGrantSchema
>;

export const manufacturingCorpusPurposePermissionsSchema = z
  .object(manufacturingCorpusPurposePermissionShape)
  .strict();

export type ManufacturingCorpusPurposePermissions = z.infer<
  typeof manufacturingCorpusPurposePermissionsSchema
>;

type DeepReadonly<T> = T extends object
  ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
  : T;

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value !== "object" || value === null) {
    return value as DeepReadonly<T>;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value) as DeepReadonly<T>;
}

function createDeniedPermissionGrant(): ManufacturingCorpusPermissionGrant {
  return {
    allowed: false,
    artifactClasses: [],
    processorPolicy: {
      executionLocation: "local_only",
      allowedProcessors: [],
      rawOutputRetentionAllowed: false,
    },
  };
}

/** Creates a mutable deny-all declaration with independent grants and arrays. */
export function createDefaultDenyManufacturingCorpusPermissions(): ManufacturingCorpusPurposePermissions {
  return {
    humanAnnotation: createDeniedPermissionGrant(),
    localParserEvaluation: createDeniedPermissionGrant(),
    geometrySdkEvaluation: createDeniedPermissionGrant(),
    modelValidation: createDeniedPermissionGrant(),
    modelTraining: createDeniedPermissionGrant(),
    commercialProductImprovement: createDeniedPermissionGrant(),
    internalDemonstration: createDeniedPermissionGrant(),
    publication: createDeniedPermissionGrant(),
    quoteOutcomeUse: createDeniedPermissionGrant(),
    benchmarkRetention: createDeniedPermissionGrant(),
  };
}

/** Immutable fail-closed example for every corpus permission purpose. */
export const DEFAULT_DENY_MANUFACTURING_CORPUS_PERMISSIONS = deepFreeze(
  createDefaultDenyManufacturingCorpusPermissions(),
);
