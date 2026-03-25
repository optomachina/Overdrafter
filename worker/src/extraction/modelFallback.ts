import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import type { WorkerConfig } from "../types.js";
import {
  renderPdfTitleBlockCrop,
  type CandidateSignal,
  type ExtractedDrawingSignals,
  type ExtractedFieldSignal,
} from "./pdfDrawing.js";

const MODEL_FIELD_NAMES = [
  "partNumber",
  "revision",
  "description",
  "material",
  "finish",
  "process",
] as const;
const CRITICAL_MODEL_FIELDS = [
  "partNumber",
  "revision",
  "description",
  "material",
  "finish",
] as const;
const MODEL_TRIGGER_CONFIDENCE = 0.78;
const MODEL_ACCEPT_CONFIDENCE = 0.8;
const PARSER_STRONG_CONFIDENCE = 0.9;
const COMPETING_CANDIDATE_DELTA = 0.24;
export const MODEL_FALLBACK_PROMPT_VERSION = "2026-03-16.v1";
export const EXTRACTION_SYSTEM_INSTRUCTION =
  "You extract structured title-block fields from engineering drawings. Return JSON only that matches the schema exactly.";
export const EXTRACTION_USER_INSTRUCTIONS = [
  "Extract raw manufacturing metadata from this engineering drawing.",
  "Return raw drawing truth only. Do not normalize or shorten text for quoting.",
  "Prefer explicit titled blocks such as DWG. NO., PART NUMBER, REV, TITLE, DESCRIPTION, MATERIAL, FINISH, and PROCESS.",
  "Reject approval names, dates, signoff blocks, standards/specs as part number, and stray isolated letters for revision.",
  "If a field is not visible, return null with low confidence.",
] as const;

type ModelFieldName = (typeof MODEL_FIELD_NAMES)[number];
type CriticalModelFieldName = (typeof CRITICAL_MODEL_FIELDS)[number];
type ModelAttempt = "title_block_crop" | "full_page";
type ModelFieldSource = "title_block" | "note" | "unknown";

const modelFieldSchema = z.object({
  value: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  fieldSource: z.enum(["title_block", "note", "unknown"]),
  reasons: z.array(z.string()).max(8).default([]),
});

export const modelResponseSchema = z.object({
  partNumber: modelFieldSchema,
  revision: modelFieldSchema,
  description: modelFieldSchema,
  material: modelFieldSchema,
  finish: modelFieldSchema,
  process: modelFieldSchema,
  titleBlockSufficient: z.boolean().default(true),
});

const PART_NUMBER_PATTERN = /\b\d{3,5}-\d{4,6}(?:-[A-Z0-9]{1,4})?\b/;
const SPEC_PATTERN = /\b(?:MIL|ASTM|AMS|QQ|ASME|SAE|ISO|DIN)[-\s/]*[A-Z0-9.]+/i;
const DATE_PATTERN = /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b|\b(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)\b/i;
const SIGNATURE_PATTERN = /\b(?:engineer|checker|checked|approvals|approved|date|ec\/date|ecn|tim)\b/i;

type ModelFieldResponse = z.infer<typeof modelFieldSchema>;
export type ParsedModelResponse = z.infer<typeof modelResponseSchema>;

export type DrawingModelExtractionResult = {
  fields: Record<ModelFieldName, ModelFieldResponse>;
  attempts: Array<{
    attempt: ModelAttempt;
    titleBlockSufficient: boolean;
    fields: Record<ModelFieldName, ModelFieldResponse>;
  }>;
  modelName: string;
  promptVersion: string;
  usedTitleBlockCrop: boolean;
  usedFullPage: boolean;
};

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeFieldValue(value: string | null) {
  return value ? normalizeWhitespace(value) : null;
}

function hasLabelEvidence(field: ExtractedFieldSignal) {
  return field.reasons.some((reason) => reason === "label_match" || reason === "spatial_match");
}

function hasCompetingCandidates(candidates: CandidateSignal[] | undefined) {
  if (!candidates || candidates.length < 2) {
    return false;
  }

  return Math.abs(candidates[0].score - candidates[1].score) <= COMPETING_CANDIDATE_DELTA;
}

function shouldUseModelForField(
  fieldName: CriticalModelFieldName,
  field: ExtractedFieldSignal,
  candidates: CandidateSignal[] | undefined,
) {
  if (!field.value) {
    return true;
  }

  if (field.confidence < MODEL_TRIGGER_CONFIDENCE) {
    return true;
  }

  if (!hasLabelEvidence(field)) {
    return true;
  }

  if (field.reasons.some((reason) => reason.startsWith("rejected_"))) {
    return true;
  }

  if (hasCompetingCandidates(candidates)) {
    return true;
  }

  if (fieldName === "revision" && field.value.length <= 1 && !field.reasons.includes("label_match")) {
    return true;
  }

  return false;
}

export function shouldTriggerDrawingModelFallback(input: {
  drawingSignals: ExtractedDrawingSignals;
  hasDrawingFile: boolean;
  modelEnabled: boolean;
}) {
  if (!input.modelEnabled || !input.hasDrawingFile) {
    return false;
  }

  return CRITICAL_MODEL_FIELDS.some((fieldName) =>
    shouldUseModelForField(
      fieldName,
      input.drawingSignals[fieldName],
      input.drawingSignals.debugCandidates[fieldName],
    ),
  );
}

export function validateModelFieldValue(field: ModelFieldName, value: string | null): string[] {
  if (!value) {
    return [];
  }

  const normalized = normalizeWhitespace(value);
  const rejectionReasons: string[] = [];

  switch (field) {
    case "partNumber":
      if (SPEC_PATTERN.test(normalized)) {
        rejectionReasons.push("rejected_spec_string");
      }
      if (DATE_PATTERN.test(normalized)) {
        rejectionReasons.push("rejected_date_metadata");
      }
      if (SIGNATURE_PATTERN.test(normalized)) {
        rejectionReasons.push("rejected_signature_block");
      }
      if (!PART_NUMBER_PATTERN.test(normalized)) {
        rejectionReasons.push("regex_fit");
      }
      break;
    case "revision":
      if (!/^[A-Z0-9]{1,4}$/i.test(normalized)) {
        rejectionReasons.push("regex_fit");
      }
      break;
    case "description":
      if (/^\d[\d\s-]*$/.test(normalized)) {
        rejectionReasons.push("rejected_numeric_description");
      }
      break;
    case "finish":
      if (SIGNATURE_PATTERN.test(normalized)) {
        rejectionReasons.push("rejected_signature_block");
      }
      if (DATE_PATTERN.test(normalized)) {
        rejectionReasons.push("rejected_date_metadata");
      }
      break;
    default:
      break;
  }

  return rejectionReasons;
}

function isModelAttemptSufficient(parsed: ParsedModelResponse) {
  return CRITICAL_MODEL_FIELDS.every((fieldName) => {
    const field = parsed[fieldName];
    return Boolean(field.value) && field.confidence >= MODEL_ACCEPT_CONFIDENCE && field.fieldSource !== "unknown";
  });
}

/**
 * Serializes drawing signal fields and top candidates into a deterministic
 * text block for inclusion in model prompts as deterministic parser context.
 *
 * @param drawingSignals - Extracted drawing signals from the PDF parser.
 * @returns Newline-joined string summarizing selected field values and debug candidates.
 */
export function serializeParserContext(drawingSignals: ExtractedDrawingSignals) {
  const lines = CRITICAL_MODEL_FIELDS.map((fieldName) => {
    const selected = drawingSignals[fieldName];
    const candidates = (drawingSignals.debugCandidates[fieldName] ?? [])
      .slice(0, 3)
      .map(
        (candidate) =>
          `${candidate.value} [score=${candidate.score.toFixed(2)} reasons=${candidate.reasons.join("|") || "none"} label=${candidate.label ?? "none"}]`,
      )
      .join("; ");

    return `${fieldName}: selected=${selected.value ?? "null"} confidence=${selected.confidence.toFixed(2)} reasons=${
      selected.reasons.join("|") || "none"
    } candidates=${candidates || "none"}`;
  });

  return lines.join("\n");
}

/**
 * Reads an image file from disk and returns a base64-encoded PNG data URL.
 *
 * @param localPath - Absolute path to the PNG image file.
 * @returns A data URL string of the form `data:image/png;base64,...`.
 */
export async function imageFileToDataUrl(localPath: string) {
  const buffer = await fs.readFile(localPath);
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

async function runModelAttempt(input: {
  client: OpenAI;
  model: string;
  drawingSignals: ExtractedDrawingSignals;
  baseName: string;
  cropPath: string | null;
  fullPagePath: string | null;
  attempt: ModelAttempt;
}) {
  const content: Array<
    | { type: "input_text"; text: string }
    | { type: "input_image"; image_url: string; detail: "high" | "auto" | "low" }
  > = [
    {
      type: "input_text",
      text: [
        ...EXTRACTION_USER_INSTRUCTIONS,
        `Filename stem: ${input.baseName}`,
        `Deterministic parser context:\n${serializeParserContext(input.drawingSignals)}`,
      ].join("\n"),
    },
  ];

  if (input.cropPath) {
    content.push({
      type: "input_image",
      image_url: await imageFileToDataUrl(input.cropPath),
      detail: "high",
    });
  }

  if (input.attempt === "full_page" && input.fullPagePath) {
    content.push({
      type: "input_image",
      image_url: await imageFileToDataUrl(input.fullPagePath),
      detail: "high",
    });
  }

  const response = await input.client.responses.parse({
    model: input.model,
    input: [
      {
        role: "developer",
        content: EXTRACTION_SYSTEM_INSTRUCTION,
      },
      {
        role: "user",
        content,
      },
    ],
    text: {
      format: zodTextFormat(modelResponseSchema, "drawing_field_extraction"),
    },
  });

  if (!response.output_parsed) {
    throw new Error("Model fallback returned no parsed extraction payload.");
  }

  return response.output_parsed;
}

export async function extractDrawingFieldsWithModel(
  input: {
    config: WorkerConfig;
    drawingPath: string;
    outputDir: string;
    baseName: string;
    drawingSignals: ExtractedDrawingSignals;
    pagePreviewPath: string | null;
  },
  dependencies: {
    client?: OpenAI;
  } = {},
): Promise<DrawingModelExtractionResult | null> {
  if (!input.config.drawingExtractionEnableModelFallback || !input.config.openAiApiKey) {
    return null;
  }

  const client = dependencies.client ?? new OpenAI({ apiKey: input.config.openAiApiKey });
  const cropPath = path.join(input.outputDir, "drawing-title-block.png");
  let titleBlockCropPath: string | null = null;
  const attempts: DrawingModelExtractionResult["attempts"] = [];

  try {
    const cropAsset = await renderPdfTitleBlockCrop(input.drawingPath, cropPath);
    titleBlockCropPath = cropAsset?.localPath ?? null;
  } catch {
    titleBlockCropPath = null;
  }

  if (titleBlockCropPath) {
    const cropAttempt = await runModelAttempt({
      client,
      model: input.config.drawingExtractionModel,
      drawingSignals: input.drawingSignals,
      baseName: input.baseName,
      cropPath: titleBlockCropPath,
      fullPagePath: null,
      attempt: "title_block_crop",
    });

    attempts.push({
      attempt: "title_block_crop",
      titleBlockSufficient: cropAttempt.titleBlockSufficient,
      fields: {
        partNumber: cropAttempt.partNumber,
        revision: cropAttempt.revision,
        description: cropAttempt.description,
        material: cropAttempt.material,
        finish: cropAttempt.finish,
        process: cropAttempt.process,
      },
    });

    if (cropAttempt.titleBlockSufficient && isModelAttemptSufficient(cropAttempt)) {
      return {
        fields: attempts[0].fields,
        attempts,
        modelName: input.config.drawingExtractionModel,
        promptVersion: MODEL_FALLBACK_PROMPT_VERSION,
        usedTitleBlockCrop: true,
        usedFullPage: false,
      };
    }
  }

  if (!input.pagePreviewPath) {
    return attempts.length > 0
      ? {
          fields: attempts[attempts.length - 1].fields,
          attempts,
          modelName: input.config.drawingExtractionModel,
          promptVersion: MODEL_FALLBACK_PROMPT_VERSION,
          usedTitleBlockCrop: Boolean(titleBlockCropPath),
          usedFullPage: false,
        }
      : null;
  }

  const fullPageAttempt = await runModelAttempt({
    client,
    model: input.config.drawingExtractionModel,
    drawingSignals: input.drawingSignals,
    baseName: input.baseName,
    cropPath: titleBlockCropPath,
    fullPagePath: input.pagePreviewPath,
    attempt: "full_page",
  });

  attempts.push({
    attempt: "full_page",
    titleBlockSufficient: fullPageAttempt.titleBlockSufficient,
    fields: {
      partNumber: fullPageAttempt.partNumber,
      revision: fullPageAttempt.revision,
      description: fullPageAttempt.description,
      material: fullPageAttempt.material,
      finish: fullPageAttempt.finish,
      process: fullPageAttempt.process,
    },
  });

  return {
    fields: attempts[attempts.length - 1].fields,
    attempts,
    modelName: input.config.drawingExtractionModel,
    promptVersion: MODEL_FALLBACK_PROMPT_VERSION,
    usedTitleBlockCrop: Boolean(titleBlockCropPath),
    usedFullPage: true,
  };
}

export function isParserSignalStrong(field: ExtractedFieldSignal) {
  return Boolean(field.value) && field.confidence >= PARSER_STRONG_CONFIDENCE && hasLabelEvidence(field);
}

export function normalizeComparableFieldValue(value: string | null) {
  return normalizeFieldValue(value)?.toUpperCase() ?? null;
}
