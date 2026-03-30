import type { ApprovedRequirementRecord, DrawingExtractionPayload } from "../types.js";

export const GEOMETRY_PROJECTION_SCHEMA_VERSION = "geometry-projection.v1";

export type GeometryProjectionPrimitiveType = "box" | "cylinder" | "hole" | "cutout";
export type GeometryFeatureClass = "hole" | "pocket" | "wall" | "cutout" | "boss" | "unknown";

export type GeometryProjectionPrimitive = {
  id: string;
  type: GeometryProjectionPrimitiveType;
  featureClass: GeometryFeatureClass;
  confidence: number;
  dimensions: Record<string, number>;
  anchor: {
    x: number;
    y: number;
    z: number;
  };
  metadata: {
    source: "requirements" | "extraction";
    sourceKey: string;
  };
};

export type GeometryProjectionArtifact = {
  artifactType: "geometry_projection";
  schemaVersion: typeof GEOMETRY_PROJECTION_SCHEMA_VERSION;
  extractorVersion: string;
  sceneVersion: 1;
  units: "mm";
  primitives: GeometryProjectionPrimitive[];
};

function clampConfidence(value: number) {
  return Math.max(0, Math.min(1, value));
}

function parseNullableNumber(raw: string | null) {
  if (!raw) {
    return null;
  }

  const normalized = raw.replace(",", ".").trim();
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function confidenceFromSignal(value: string | null, baseConfidence: number) {
  return value ? clampConfidence(baseConfidence) : clampConfidence(baseConfidence * 0.6);
}

function makeBaseBox(requirement: ApprovedRequirementRecord | null, extraction: DrawingExtractionPayload) {
  const length = parseNullableNumber(extraction.generalTolerance.raw) ?? 120;
  const width = extraction.partNumber ? 80 : 60;
  const height = extraction.finish.normalized ? 40 : 30;

  return {
    id: "base-box",
    type: "box" as const,
    featureClass: "wall" as const,
    confidence: clampConfidence((extraction.material.confidence + extraction.finish.confidence) / 2 || 0.65),
    dimensions: {
      length,
      width,
      height,
    },
    anchor: { x: 0, y: 0, z: 0 },
    metadata: {
      source: requirement ? ("requirements" as const) : ("extraction" as const),
      sourceKey: requirement ? "approved_part_requirements" : "drawing_extractions",
    },
  };
}

function deriveFeaturePrimitives(extraction: DrawingExtractionPayload) {
  const primitives: GeometryProjectionPrimitive[] = [];
  const notesText = extraction.notes.join(" ").toLowerCase();
  const threadsText = extraction.threads.join(" ").toLowerCase();

  if (notesText.includes("hole") || threadsText.includes("thread")) {
    primitives.push({
      id: "feature-hole-1",
      type: "hole",
      featureClass: "hole",
      confidence: confidenceFromSignal(extraction.partNumber, 0.72),
      dimensions: {
        diameter: 10,
        depth: 20,
      },
      anchor: { x: 15, y: 15, z: 0 },
      metadata: {
        source: "extraction",
        sourceKey: "notes|threads",
      },
    });
  }

  if (notesText.includes("pocket")) {
    primitives.push({
      id: "feature-cutout-1",
      type: "cutout",
      featureClass: "pocket",
      confidence: confidenceFromSignal(extraction.description, 0.68),
      dimensions: {
        width: 22,
        length: 36,
        depth: 6,
      },
      anchor: { x: 20, y: 14, z: 5 },
      metadata: {
        source: "extraction",
        sourceKey: "notes",
      },
    });
  }

  if (extraction.tightestTolerance.valueInch !== null && extraction.tightestTolerance.valueInch <= 0.01) {
    primitives.push({
      id: "feature-cylinder-1",
      type: "cylinder",
      featureClass: "boss",
      confidence: clampConfidence(extraction.tightestTolerance.confidence),
      dimensions: {
        radius: 8,
        height: 12,
      },
      anchor: { x: 42, y: 20, z: 0 },
      metadata: {
        source: "extraction",
        sourceKey: "tightestTolerance",
      },
    });
  }

  return primitives;
}

export function buildGeometryProjectionArtifact(input: {
  extraction: DrawingExtractionPayload;
  requirement: ApprovedRequirementRecord | null;
  extractorVersion: string;
}): GeometryProjectionArtifact {
  const base = makeBaseBox(input.requirement, input.extraction);
  const derived = deriveFeaturePrimitives(input.extraction);
  const primitives = [base, ...derived];

  if (primitives.length === 0) {
    throw new Error("Failed to construct geometry projection primitives.");
  }

  return {
    artifactType: "geometry_projection",
    schemaVersion: GEOMETRY_PROJECTION_SCHEMA_VERSION,
    extractorVersion: input.extractorVersion,
    sceneVersion: 1,
    units: "mm",
    primitives,
  };
}
