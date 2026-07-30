import { z } from "zod";

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

export const manufacturingCorpusStableIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "must be a stable lowercase identifier");
export const manufacturingCorpusOpaqueReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(512);
export const manufacturingCorpusSha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "must be a lowercase SHA-256 digest");
export const manufacturingCorpusUtcTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine(
    (value) => value.endsWith("Z"),
    "must be a UTC timestamp ending in Z",
  );

export type ManufacturingCorpusJsonValue =
  | boolean
  | number
  | string
  | null
  | ManufacturingCorpusJsonValue[]
  | { [key: string]: ManufacturingCorpusJsonValue };

export const manufacturingCorpusJsonValueSchema: z.ZodType<ManufacturingCorpusJsonValue> =
  z.lazy(() =>
    z.union([
      z.boolean(),
      z.number().finite(),
      z.string(),
      z.null(),
      z.array(manufacturingCorpusJsonValueSchema),
      z.record(manufacturingCorpusJsonValueSchema),
    ]),
  );

export function manufacturingCorpusHasDuplicates(
  values: readonly string[],
): boolean {
  return new Set(values).size !== values.length;
}

const processorPolicySchema = z
  .object({
    executionLocation: z.enum(["local_only", "approved_service"]),
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

export const manufacturingCorpusPermissionGrantSchema = z
  .object({
    allowed: z.boolean(),
    artifactClasses: z.array(manufacturingCorpusArtifactClassSchema),
    processorPolicy: processorPolicySchema,
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

export type ManufacturingProcessFamily = z.infer<
  typeof manufacturingProcessFamilySchema
>;
export type ManufacturingQualificationTarget = z.infer<
  typeof manufacturingQualificationTargetSchema
>;
