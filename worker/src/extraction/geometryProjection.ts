import type { DrawingExtractionPayload } from "../types.js";

export type GeometryProjectionScene = {
  schemaVersion: "v1";
  extractorVersion: string;
  features: Array<{
    id: string;
    label: string;
    featureClass: "box" | "cylinder" | "hole" | "cutout";
    confidence: number;
    riskFlags: string[];
  }>;
  primitives: Array<{
    id: string;
    type: "box" | "cylinder" | "hole" | "cutout";
    x: number;
    y: number;
    width: number;
    height: number;
    featureId: string;
  }>;
};

export function buildGeometryProjection(input: {
  extraction: Pick<DrawingExtractionPayload, "partNumber" | "description" | "threads" | "notes" | "tightestTolerance">;
  extractorVersion: string;
}): GeometryProjectionScene {
  const seedSource = `${input.extraction.partNumber ?? "part"}:${input.extraction.description ?? ""}`;
  const seed = [...seedSource].reduce((total, char) => total + char.charCodeAt(0), 0);
  const tolerance = input.extraction.tightestTolerance.valueInch ?? 0;

  const features: GeometryProjectionScene["features"] = [
    {
      id: "feat-base",
      label: "Base stock",
      featureClass: "box",
      confidence: 0.74,
      riskFlags: tolerance > 0 && tolerance <= 0.005 ? ["thin_wall"] : [],
    },
    {
      id: "feat-pocket",
      label: "Primary pocket",
      featureClass: "cutout",
      confidence: 0.62,
      riskFlags: input.extraction.notes.length > 0 ? ["deep_pocket"] : [],
    },
    {
      id: "feat-hole",
      label: "Threaded feature",
      featureClass: "hole",
      confidence: input.extraction.threads.length > 0 ? 0.78 : 0.45,
      riskFlags: input.extraction.threads.length > 2 ? ["hole_cluster"] : [],
    },
  ];

  const xOffset = seed % 12;

  return {
    schemaVersion: "v1",
    extractorVersion: input.extractorVersion,
    features,
    primitives: [
      { id: "prim-base", type: "box", x: 8 + xOffset, y: 18, width: 70, height: 54, featureId: "feat-base" },
      { id: "prim-pocket", type: "cutout", x: 32, y: 34, width: 28, height: 20, featureId: "feat-pocket" },
      { id: "prim-hole", type: "hole", x: 64, y: 26, width: 9, height: 9, featureId: "feat-hole" },
    ],
  };
}

