import { z } from "zod";
import { manufacturingCorpusRightsSchema } from "./manufacturingCorpusRightsContract.js";
import {
  manufacturingCorpusArtifactClassSchema,
  manufacturingCorpusDataClassificationSchema,
  manufacturingCorpusHasDuplicates,
  manufacturingCorpusOpaqueReferenceSchema,
  manufacturingCorpusSha256Schema,
  manufacturingCorpusSourceClassSchema,
  manufacturingCorpusStableIdSchema,
  manufacturingProcessFamilySchema,
  manufacturingQualificationTargetSchema,
} from "./manufacturingCorpusVocabulary.js";

export const MANUFACTURING_CORPUS_MANIFEST_SCHEMA_VERSION =
  "manufacturing-corpus-manifest.v1";
export const MANUFACTURING_CORPUS_ROOT_SCHEMA_VERSION =
  "manufacturing-corpus-root.v1";
export const MANUFACTURING_CORPUS_CASE_SCHEMA_VERSION =
  "manufacturing-corpus-case.v1";
export const MANUFACTURING_CORPUS_TARGET_SCHEMA_VERSION =
  "manufacturing-corpus-target.v1";

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

const corpusRootBaseShape = {
  schemaVersion: z.literal(MANUFACTURING_CORPUS_ROOT_SCHEMA_VERSION),
  rootId: manufacturingCorpusStableIdSchema,
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
          (values) => !manufacturingCorpusHasDuplicates(values),
          "must not contain duplicate data classifications",
        ),
    })
    .strict(),
]);

export const manufacturingCorpusArtifactSchema = z
  .object({
    artifactId: manufacturingCorpusStableIdSchema,
    artifactClass: manufacturingCorpusArtifactClassSchema,
    rootId: manufacturingCorpusStableIdSchema,
    relativePath: portableRelativeFilePathSchema,
    mediaType: z
      .string()
      .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i),
    byteSize: z.number().int().nonnegative().safe(),
    sha256: manufacturingCorpusSha256Schema,
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
      reviewRef: manufacturingCorpusOpaqueReferenceSchema,
    })
    .strict(),
  z
    .object({
      state: z.literal("verified"),
      reviewRef: manufacturingCorpusOpaqueReferenceSchema,
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
    caseId: manufacturingCorpusStableIdSchema,
    processFamilies: z.array(manufacturingProcessFamilySchema).min(1),
    qualificationTarget: manufacturingQualificationTargetSchema,
    sourceClass: manufacturingCorpusSourceClassSchema,
    dataClassification: manufacturingCorpusDataClassificationSchema,
    redaction: redactionDeclarationSchema,
    protectedSourceRef: manufacturingCorpusOpaqueReferenceSchema,
    rightsId: manufacturingCorpusStableIdSchema,
    artifacts: z.array(manufacturingCorpusArtifactSchema).min(1),
    annotationArtifact: manufacturingCorpusAnnotationArtifactSchema,
    executionLimits: executionLimitsSchema,
  })
  .strict()
  .superRefine((corpusCase, context) => {
    if (manufacturingCorpusHasDuplicates(corpusCase.processFamilies)) {
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
export type ManufacturingCorpusManifest = z.infer<
  typeof manufacturingCorpusManifestSchema
>;
