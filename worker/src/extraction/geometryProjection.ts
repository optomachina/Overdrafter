import type { ApprovedRequirementRecord, DrawingExtractionPayload } from "../types.js";

export const GEOMETRY_PROJECTION_SCHEMA_VERSION = "geometry_projection.v1" as const;
export const GEOMETRY_PROJECTION_EXTRACTOR_VERSION = "worker-geometry-v1" as const;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function hashSeed(input: string) {
  let hash = 0;

  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }

  return hash;
}

export function buildGeometryProjection(input: {
  extraction: Pick<DrawingExtractionPayload, "partId" | "partNumber" | "description" | "threads" | "notes" | "warnings">;
  requirement: ApprovedRequirementRecord | null;
}) {
  const seedSource = input.extraction.partNumber ?? input.extraction.description ?? input.extraction.partId;

  if (!seedSource) {
    throw new Error("Geometry projection requires part identity.");
  }

  const seed = hashSeed(seedSource);
  const quantity = input.requirement?.quantity ?? 1;
  const baseWidth = clamp(68 + (seed % 24), 64, 110);
  const baseHeight = clamp(18 + ((seed >> 3) % 14), 16, 42);
  const baseDepth = clamp(40 + ((seed >> 6) % 20), 36, 80);
  const primitiveCount = clamp(1 + Math.min(input.extraction.threads.length, 3), 1, 4);

  const primitives: NonNullable<DrawingExtractionPayload["geometryProjection"]>["scene"]["primitives"] = [
    {
      id: "body-main",
      kind: "box",
      position: { x: 0, y: 0, z: 0 },
      size: { x: baseWidth, y: baseHeight, z: baseDepth },
      metadata: {
        featureClass: "body",
        confidence: 0.74,
      },
    },
  ];

  for (let index = 0; index < primitiveCount - 1; index += 1) {
    primitives.push({
      id: `hole-${index + 1}`,
      kind: "hole",
      position: {
        x: -baseWidth / 4 + index * (baseWidth / 5),
        y: 0,
        z: baseDepth / 4 - index * 4,
      },
      size: { x: 6 + (seed % 3), y: baseHeight + 2, z: 6 + (seed % 3) },
      metadata: {
        featureClass: "hole",
        confidence: 0.6,
      },
    });
  }

  primitives.push({
    id: "pocket-1",
    kind: "cutout",
    position: { x: baseWidth * 0.2, y: baseHeight * 0.2, z: 0 },
    size: { x: Math.max(10, baseWidth * 0.24), y: Math.max(4, baseHeight * 0.5), z: Math.max(8, baseDepth * 0.22) },
    metadata: {
      featureClass: "pocket",
      confidence: input.extraction.notes.length > 0 || input.extraction.warnings.length === 0 ? 0.64 : 0.52,
    },
  });

  if (quantity >= 25) {
    primitives.push({
      id: "wall-thin-1",
      kind: "cylinder",
      position: { x: -baseWidth * 0.18, y: baseHeight * 0.18, z: -baseDepth * 0.2 },
      size: { x: 4, y: baseHeight, z: 4 },
      metadata: {
        featureClass: "wall",
        confidence: 0.57,
      },
    });
  }

  return {
    schemaVersion: GEOMETRY_PROJECTION_SCHEMA_VERSION,
    extractorVersion: GEOMETRY_PROJECTION_EXTRACTOR_VERSION,
    generatedFrom: {
      drawingExtraction: true,
      approvedRequirement: Boolean(input.requirement),
    },
    scene: {
      width: baseWidth,
      height: baseHeight,
      depth: baseDepth,
      primitives,
    },
  } satisfies NonNullable<DrawingExtractionPayload["geometryProjection"]>;
}
