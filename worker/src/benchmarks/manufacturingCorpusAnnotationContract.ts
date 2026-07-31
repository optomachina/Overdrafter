import { z } from "zod";
import {
  manufacturingCorpusJsonValueSchema,
  manufacturingCorpusOpaqueReferenceSchema,
  manufacturingCorpusStableIdSchema,
  manufacturingCorpusUtcTimestampSchema,
  manufacturingProcessFamilySchema,
} from "./manufacturingCorpusVocabulary.js";

export const MANUFACTURING_CORPUS_ANNOTATION_SCHEMA_VERSION =
  "manufacturing-corpus-annotation.v1";

const annotationEvidenceSchema = z
  .object({
    artifactId: manufacturingCorpusStableIdSchema,
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
      reasonCode: manufacturingCorpusStableIdSchema,
      evidence: z.array(annotationEvidenceSchema).min(1),
    })
    .strict(),
  z
    .object({
      state: z.literal("not_applicable"),
      reasonCode: manufacturingCorpusStableIdSchema,
      evidence: z.array(annotationEvidenceSchema).min(1),
    })
    .strict(),
  z
    .object({
      state: z.literal("parse_failed"),
      reasonCode: manufacturingCorpusStableIdSchema,
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
      reasonCode: manufacturingCorpusStableIdSchema,
      evidence: z.array(annotationEvidenceSchema).min(1),
    })
    .strict(),
]);

const expectedExecutionSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("success"),
      diagnosticCodes: z.array(manufacturingCorpusStableIdSchema).length(0),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("bounded_failure"),
      diagnosticCodes: z.array(manufacturingCorpusStableIdSchema).min(1),
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
      reviewerRole: manufacturingCorpusStableIdSchema,
      reviewerRef: manufacturingCorpusOpaqueReferenceSchema,
      reviewedAt: manufacturingCorpusUtcTimestampSchema,
      reviewRef: manufacturingCorpusOpaqueReferenceSchema,
      reviewPolicyVersion: z.string().trim().min(1),
    })
    .strict(),
]);

export const manufacturingCorpusAnnotationSchema = z
  .object({
    schemaVersion: z.literal(MANUFACTURING_CORPUS_ANNOTATION_SCHEMA_VERSION),
    annotationRevision: z.string().trim().min(1),
    caseId: manufacturingCorpusStableIdSchema,
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
              label: manufacturingCorpusStableIdSchema,
              count: z.number().int().nonnegative().safe(),
              parameters: z.record(manufacturingCorpusJsonValueSchema),
              evidence: z.array(annotationEvidenceSchema).min(1),
            })
            .strict(),
        ),
        requirements: z.array(
          z
            .object({
              key: manufacturingCorpusStableIdSchema,
              value: manufacturingCorpusJsonValueSchema,
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
              code: manufacturingCorpusStableIdSchema,
              evidence: z.array(annotationEvidenceSchema).min(1),
            })
            .strict(),
        ),
        execution: expectedExecutionSchema,
      })
      .strict(),
  })
  .strict();

export type ManufacturingCorpusAnnotation = z.infer<
  typeof manufacturingCorpusAnnotationSchema
>;
