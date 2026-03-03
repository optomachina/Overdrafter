import path from "node:path";
import type {
  DrawingExtractionPayload,
  JobFileRecord,
  PartRecord,
} from "../types.js";

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function baseName(file: JobFileRecord | null, fallback: string): string {
  if (!file) {
    return fallback;
  }

  return path.basename(file.original_name, path.extname(file.original_name));
}

export async function runHybridExtraction(input: {
  part: PartRecord;
  cadFile: JobFileRecord | null;
  drawingFile: JobFileRecord | null;
}): Promise<DrawingExtractionPayload> {
  const inferredBase = baseName(input.drawingFile ?? input.cadFile, input.part.name);
  const normalizedTitle = titleCase(inferredBase);
  const warnings: string[] = [];

  if (!input.drawingFile) {
    warnings.push("No PDF drawing was attached. Material, finish, and tolerance values require review.");
  }

  return {
    partId: input.part.id,
    description: normalizedTitle,
    partNumber: inferredBase.toUpperCase(),
    revision: null,
    material: {
      raw: null,
      normalized: null,
      confidence: input.drawingFile ? 0.35 : 0.15,
    },
    finish: {
      raw: null,
      normalized: null,
      confidence: input.drawingFile ? 0.25 : 0.1,
    },
    tightestTolerance: {
      raw: null,
      valueInch: null,
      confidence: input.drawingFile ? 0.25 : 0.1,
    },
    evidence: [
      {
        field: "description",
        page: 1,
        snippet: normalizedTitle,
        confidence: 0.75,
      },
    ],
    warnings,
    status: "needs_review",
  };
}
