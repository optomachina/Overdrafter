import path from "node:path";
import { DRAWING_FIELD_NAMES, SUPPORTED_REVIEW_FIELDS } from "../types.js";
import type {
  DrawingExtractionPayload,
  JobFileRecord,
  PartRecord,
  SupportedReviewField,
  WorkerConfig,
} from "../types.js";
import {
  extractDrawingFieldsWithModel,
  isParserSignalStrong,
  MODEL_FALLBACK_PROMPT_VERSION,
  normalizeComparableFieldValue,
  shouldTriggerDrawingModelFallback,
  validateModelFieldValue,
  type DrawingModelExtractionResult,
} from "./modelFallback.js";
import {
  buildGeometryProjection,
} from "./geometryProjection.js";
import {
  inferDrawingSignalsFromPdf,
  normalizeQuoteDescription,
  normalizeQuoteFinish,
  type ExtractedDrawingSignals,
  type ExtractedFieldSignal,
  type PdfTextExtraction,
} from "./pdfDrawing.js";

const MODEL_ACCEPT_CONFIDENCE = 0.8;
const MODEL_SELECTION_BONUS = 0.08;
const SUPPORTED_REVIEW_FIELD_SET = new Set<SupportedReviewField>(SUPPORTED_REVIEW_FIELDS);

type MergeFieldName = (typeof DRAWING_FIELD_NAMES)[number];
type ModelCandidateRecord = NonNullable<DrawingExtractionPayload["modelCandidates"]>[MergeFieldName];

function titleCase(value: string) {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function baseName(file: JobFileRecord | null, fallback: string) {
  if (!file) {
    return fallback;
  }

  return path.basename(file.original_name, path.extname(file.original_name));
}

function cloneField(field: ExtractedFieldSignal): ExtractedFieldSignal {
  return {
    value: field.value,
    confidence: field.confidence,
    reviewNeeded: field.reviewNeeded,
    reasons: [...field.reasons],
    sourceRegion: field.sourceRegion ? { ...field.sourceRegion } : null,
    snippet: field.snippet,
  };
}

function uniqueReasons(reasons: string[]) {
  return [...new Set(reasons.filter(Boolean))];
}

function nonFieldWarnings(warnings: string[]) {
  return warnings.filter((warning) => !/ extraction needs review\.$/i.test(warning));
}

function buildModelSignal(
  fieldName: MergeFieldName,
  field: DrawingModelExtractionResult["fields"][MergeFieldName],
): ExtractedFieldSignal {
  const selectionReasons = [
    ...field.reasons,
    "model_fallback",
    field.fieldSource === "title_block" ? "label_match" : null,
  ].filter((reason): reason is string => Boolean(reason));

  return {
    value: field.value,
    confidence: field.confidence,
    reviewNeeded: !field.value || field.confidence < MODEL_ACCEPT_CONFIDENCE || field.fieldSource === "unknown",
    reasons: uniqueReasons(selectionReasons),
    sourceRegion: null,
    snippet: field.value,
  };
}

function valuesMateriallyDiffer(left: string | null, right: string | null) {
  return normalizeComparableFieldValue(left) !== normalizeComparableFieldValue(right);
}

function rebuildWarnings(fields: Record<MergeFieldName, ExtractedFieldSignal>, baselineWarnings: string[]) {
  const warnings = [...nonFieldWarnings(baselineWarnings)];

  for (const [fieldName, field] of Object.entries(fields) as Array<[MergeFieldName, ExtractedFieldSignal]>) {
    if (field.reviewNeeded) {
      warnings.push(`${fieldName.charAt(0).toUpperCase()}${fieldName.slice(1)} extraction needs review.`);
    }
  }

  return uniqueReasons(warnings);
}

function mergeFieldSignals(input: {
  fieldName: MergeFieldName;
  parserField: ExtractedFieldSignal;
  modelResult: DrawingModelExtractionResult | null;
  warnings: string[];
}) {
  const selection = {
    field: cloneField(input.parserField),
    selectedBy: "parser" as "parser" | "model" | "review",
    modelCandidate: null as ModelCandidateRecord | null,
  };

  if (!input.modelResult) {
    return selection;
  }

  const lastAttempt = input.modelResult.attempts[input.modelResult.attempts.length - 1];
  const modelField = input.modelResult.fields[input.fieldName];
  const rejectionReasons = uniqueReasons([
    ...modelField.reasons,
    ...validateModelFieldValue(input.fieldName, modelField.value),
  ]);

  selection.modelCandidate = {
    value: modelField.value,
    confidence: modelField.confidence,
    fieldSource: modelField.fieldSource,
    selected: false,
    reasons: rejectionReasons,
    attempt: lastAttempt.attempt,
  };

  if (!modelField.value || rejectionReasons.some((reason) => reason.startsWith("rejected_"))) {
    return selection;
  }

  const parserStrong = isParserSignalStrong(input.parserField);
  const modelStrong =
    modelField.confidence >= MODEL_ACCEPT_CONFIDENCE && modelField.fieldSource !== "unknown";
  const differs = valuesMateriallyDiffer(input.parserField.value, modelField.value);

  if (!input.parserField.value) {
    selection.field = buildModelSignal(input.fieldName, modelField);
    selection.selectedBy = "model";
    selection.modelCandidate.selected = true;
    return selection;
  }

  if (!differs) {
    selection.field = {
      ...selection.field,
      confidence: Math.max(selection.field.confidence, modelField.confidence),
      reviewNeeded:
        selection.field.reviewNeeded &&
        (modelField.confidence < MODEL_ACCEPT_CONFIDENCE || modelField.fieldSource === "unknown"),
    };
    return selection;
  }

  if (
    !parserStrong &&
    modelStrong &&
    modelField.confidence >= input.parserField.confidence + MODEL_SELECTION_BONUS
  ) {
    selection.field = buildModelSignal(input.fieldName, modelField);
    selection.selectedBy = "model";
    selection.modelCandidate.selected = true;
    return selection;
  }

  selection.field = {
    ...selection.field,
    reviewNeeded: true,
    reasons: uniqueReasons([...selection.field.reasons, "model_conflict"]),
  };
  selection.selectedBy = "review";
  input.warnings.push(
    `${input.fieldName.charAt(0).toUpperCase()}${input.fieldName.slice(1)} parser/model disagreement needs review.`,
  );
  return selection;
}

export async function runHybridExtraction(
  input: {
    part: PartRecord;
    cadFile: JobFileRecord | null;
    drawingFile: JobFileRecord | null;
    pdfText?: PdfTextExtraction | null;
    drawingPath?: string | null;
    previewPagePath?: string | null;
    runDir?: string | null;
    config?: WorkerConfig;
    forceModelFallback?: boolean;
  },
  dependencies: {
    extractWithModel?: typeof extractDrawingFieldsWithModel;
  } = {},
): Promise<DrawingExtractionPayload> {
  const inferredBase = baseName(input.drawingFile ?? input.cadFile, input.part.name);
  const normalizedTitle = titleCase(inferredBase);
  const drawingSignals = inferDrawingSignalsFromPdf({
    baseName: inferredBase,
    pdfText: input.pdfText ?? null,
  });

  const warnings = [...drawingSignals.warnings];
  let modelResult: DrawingModelExtractionResult | null = null;

  if (
    input.config &&
    input.drawingPath &&
    input.runDir &&
    (input.forceModelFallback ||
      shouldTriggerDrawingModelFallback({
        drawingSignals,
        hasDrawingFile: Boolean(input.drawingFile),
        modelEnabled:
          input.config.drawingExtractionEnableModelFallback &&
          Boolean(
            input.config.openAiApiKey || input.config.anthropicApiKey || input.config.openRouterApiKey,
          ),
      }))
  ) {
    try {
      modelResult = await (dependencies.extractWithModel ?? extractDrawingFieldsWithModel)({
        config: input.config,
        drawingPath: input.drawingPath,
        outputDir: input.runDir,
        baseName: inferredBase,
        drawingSignals,
        pagePreviewPath: input.previewPagePath ?? null,
      });
    } catch (error) {
      warnings.push(
        `Model fallback failed for drawing extraction: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const mergedFields = {
    description: cloneField(drawingSignals.description),
    partNumber: cloneField(drawingSignals.partNumber),
    revision: cloneField(drawingSignals.revision),
    material: cloneField(drawingSignals.material),
    finish: cloneField(drawingSignals.finish),
    process: cloneField(drawingSignals.process),
  } satisfies Record<MergeFieldName, ExtractedFieldSignal>;
  const fieldSelections: NonNullable<DrawingExtractionPayload["fieldSelections"]> = {
    description: "parser",
    partNumber: "parser",
    revision: "parser",
    material: "parser",
    finish: "parser",
    process: "parser",
  };
  const modelCandidates: NonNullable<DrawingExtractionPayload["modelCandidates"]> = {};

  for (const fieldName of DRAWING_FIELD_NAMES) {
    const merged = mergeFieldSignals({
      fieldName,
      parserField: drawingSignals[fieldName],
      modelResult,
      warnings,
    });

    mergedFields[fieldName] = merged.field;
    fieldSelections[fieldName] = merged.selectedBy;

    if (merged.modelCandidate) {
      modelCandidates[fieldName] = merged.modelCandidate;
    }
  }

  const description = mergedFields.description.value ?? normalizedTitle;
  const partNumber = mergedFields.partNumber.value ?? inferredBase.toUpperCase();
  const finishRaw = mergedFields.finish.value;
  const reviewFields = (Object.entries(mergedFields) as Array<[MergeFieldName, ExtractedFieldSignal]>)
    .filter(
      ([fieldName, field]) =>
        SUPPORTED_REVIEW_FIELD_SET.has(fieldName as SupportedReviewField) && field.reviewNeeded,
    )
    .map(([fieldName]) => fieldName as SupportedReviewField);
  const quoteDescription = normalizeQuoteDescription(description);
  const quoteFinish = normalizeQuoteFinish(finishRaw);

  if (!input.drawingFile) {
    warnings.push("No PDF drawing was attached. Material, finish, and tolerance values require review.");
  }

  const rebuiltWarnings = rebuildWarnings(mergedFields, warnings);
  const blockingWarningCount = rebuiltWarnings.filter(
    (warning) => !/^Process extraction needs review\.$/i.test(warning),
  ).length;
  const evidence =
    [
      ...drawingSignals.evidence.filter((item) => fieldSelections[item.field as MergeFieldName] !== "model"),
      ...DRAWING_FIELD_NAMES.filter((fieldName) => fieldSelections[fieldName] === "model").flatMap((fieldName) => {
        const field = mergedFields[fieldName];

        if (!field.value) {
          return [];
        }

        return [
          {
            field: fieldName,
            page: 1,
            snippet: field.snippet ?? field.value,
            confidence: field.confidence,
            reasons: field.reasons,
          },
        ];
      }),
    ].filter((item, index, items) => items.findIndex((candidate) => candidate.field === item.field) === index) ??
    [];
  const geometryProjection = buildGeometryProjection({
    extraction: {
      partNumber,
      description,
      threads: drawingSignals.threads,
      notes: drawingSignals.notes,
      tightestTolerance: {
        raw: drawingSignals.tightestTolerance,
        valueInch: drawingSignals.tightestTolerance
          ? Number.parseFloat(drawingSignals.tightestTolerance.replace(/[^0-9.]/g, "")) || null
          : null,
        confidence: drawingSignals.tightestTolerance ? 0.68 : input.drawingFile ? 0.25 : 0.1,
      },
    },
    extractorVersion: "worker-geometry-projection-v1",
  });

  return {
    partId: input.part.id,
    description,
    partNumber,
    revision: mergedFields.revision.value,
    modelFallbackUsed: Boolean(modelResult),
    modelName: modelResult?.modelName ?? null,
    modelPromptVersion: modelResult ? MODEL_FALLBACK_PROMPT_VERSION : null,
    fieldSelections,
    extractedDescriptionRaw: {
      value: description,
      confidence: mergedFields.description.confidence,
      reviewNeeded: mergedFields.description.reviewNeeded,
      reasons: mergedFields.description.reasons,
      sourceRegion: mergedFields.description.sourceRegion,
    },
    extractedPartNumberRaw: {
      value: partNumber,
      confidence: mergedFields.partNumber.confidence,
      reviewNeeded: mergedFields.partNumber.reviewNeeded,
      reasons: mergedFields.partNumber.reasons,
      sourceRegion: mergedFields.partNumber.sourceRegion,
    },
    extractedRevisionRaw: {
      value: mergedFields.revision.value,
      confidence: mergedFields.revision.confidence,
      reviewNeeded: mergedFields.revision.reviewNeeded,
      reasons: mergedFields.revision.reasons,
      sourceRegion: mergedFields.revision.sourceRegion,
    },
    extractedFinishRaw: {
      value: finishRaw,
      confidence: mergedFields.finish.confidence,
      reviewNeeded: mergedFields.finish.reviewNeeded,
      reasons: mergedFields.finish.reasons,
      sourceRegion: mergedFields.finish.sourceRegion,
    },
    quoteDescription,
    quoteFinish,
    reviewFields,
    material: {
      raw: mergedFields.material.value,
      normalized: mergedFields.material.value,
      confidence: mergedFields.material.value
        ? mergedFields.material.confidence
        : input.drawingFile
          ? 0.35
          : 0.15,
      reviewNeeded: mergedFields.material.reviewNeeded,
      reasons: mergedFields.material.reasons,
    },
    finish: {
      raw: finishRaw,
      normalized: quoteFinish ?? finishRaw,
      confidence: mergedFields.finish.value
        ? mergedFields.finish.confidence
        : input.drawingFile
          ? 0.25
          : 0.1,
      reviewNeeded: mergedFields.finish.reviewNeeded,
      reasons: mergedFields.finish.reasons,
    },
    generalTolerance: {
      raw: drawingSignals.generalTolerance,
      confidence: drawingSignals.generalTolerance ? 0.68 : input.drawingFile ? 0.2 : 0.1,
    },
    tightestTolerance: {
      raw: drawingSignals.tightestTolerance,
      valueInch: drawingSignals.tightestTolerance
        ? Number.parseFloat(drawingSignals.tightestTolerance.replace(/[^0-9.]/g, "")) || null
        : null,
      confidence: drawingSignals.tightestTolerance ? 0.68 : input.drawingFile ? 0.25 : 0.1,
    },
    notes: drawingSignals.notes,
    threads: drawingSignals.threads,
    evidence:
      evidence.length > 0
        ? evidence
        : [
            {
              field: "description",
              page: 1,
              snippet: normalizedTitle,
              confidence: 0.75,
              reasons: ["regex_fit"],
            },
          ],
    warnings: rebuiltWarnings,
    debugCandidates: drawingSignals.debugCandidates,
    modelCandidates,
    geometryProjection,
    status: reviewFields.length > 0 || blockingWarningCount > 0 ? "needs_review" : "approved",
  };
}
