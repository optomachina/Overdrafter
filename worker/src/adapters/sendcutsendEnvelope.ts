import { normalizeStepToCanonicalGeometryMetadata } from "../extraction/stepGeometryMetadata.js";

const UNSUPPORTED_STEP_STRUCTURE_PATTERNS = [
  /\b(?:CARTESIAN_TRANSFORMATION_OPERATOR(?:_2D|_3D)?|CONTEXT_DEPENDENT_SHAPE_REPRESENTATION|ITEM_DEFINED_TRANSFORMATION|MAPPED_ITEM|REPRESENTATION_MAP|REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION|SHAPE_REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION)\s*\(/i,
  /\b(?:ASSEMBLY_COMPONENT_USAGE|NEXT_ASSEMBLY_USAGE_OCCURRENCE|PRODUCT_DEFINITION_RELATIONSHIP|PRODUCT_DEFINITION_USAGE|QUANTIFIED_ASSEMBLY_COMPONENT_USAGE|SPECIFIED_HIGHER_USAGE_OCCURRENCE)\s*\(/i,
  /\b(?:FACETED_BREP|GEOMETRIC_SET|OPEN_SHELL|SHELL_BASED_SURFACE_MODEL)\s*\(/i,
] as const;
const SUPPORTED_STEP_CURVE_SURFACE_ENTITY_TYPES = new Set(["LINE", "PLANE"]);
const NON_GEOMETRY_CURVE_ENTITY_TYPES = new Set(["EDGE_CURVE"]);
const STEP_CALL_TYPE_PATTERN = /\b([A-Z][A-Z0-9_]*)\s*\(/g;
const STEP_QUOTED_STRING_PATTERN = /'(?:''|[^'])*'/g;
const EXPLICIT_CURVE_SURFACE_ENTITY_TYPES = new Set([
  "CIRCLE",
  "ELLIPSE",
  "HYPERBOLA",
  "PARABOLA",
]);

export const SENDCUTSEND_CNC_ENVELOPE_REVISION = "sendcutsend-cnc-envelope.v1";

export const SENDCUTSEND_CNC_ENVELOPE = {
  revision: SENDCUTSEND_CNC_ENVELOPE_REVISION,
  reviewedAt: "2026-08-26",
  accountMode: "company_controlled",
  process: "cnc_machining",
  fileExtensions: ["step", "stp"],
  material: "6061-T6 aluminum",
  standardToleranceInch: 0.005,
  minimumQuantity: 1,
  maximumQuantity: null,
  minimumDimensionsInch: [1, 1, 1],
  maximumDimensionsInch: [7, 7, 12],
  supportedFinishes: ["as_machined"],
  drawingUpload: false,
  orderPlacement: false,
  evidence: [
    "https://sendcutsend.com/guidelines/cnc-machining/",
    "https://sendcutsend.com/materials/cnc/6061-aluminum/",
    "https://sendcutsend.com/services/cnc-machining/",
  ],
  evidenceNotes: [
    "The dedicated CNC guideline and 6061 page publish a 0.5-inch minimum, while the CNC service FAQ publishes a 1-inch minimum. This certified envelope uses the conservative 1-inch intersection.",
    "Feature-level machinability beyond the deterministic solid-body and overall-size checks remains subject to the provider portal's DFM result.",
  ],
} as const;

export type SendCutSendAccountMode = typeof SENDCUTSEND_CNC_ENVELOPE.accountMode;

export type SendCutSendGeometry = {
  units: "inch" | "millimeter" | "unsupported";
  solidBodyCount: number;
  surfaceBodyCount: number;
  dimensions: [number, number, number] | null;
};

export type SendCutSendEnvelopeInput = {
  fileName: string;
  process: string | null;
  material: string;
  finish: string | null;
  tightestToleranceInch: number | null;
  quantity: number;
  drawingIncluded: boolean;
  accountMode: string;
  geometry: SendCutSendGeometry | null;
};

export type SendCutSendEnvelopeDenialCode =
  | "account_mode_unsupported"
  | "drawing_not_supported"
  | "file_format_unsupported"
  | "finish_unsupported"
  | "geometry_dimensions_invalid"
  | "geometry_too_large"
  | "geometry_too_small"
  | "geometry_unavailable"
  | "geometry_units_unsupported"
  | "material_unsupported"
  | "multiple_or_surface_bodies_unsupported"
  | "process_unsupported"
  | "quantity_unsupported"
  | "tolerance_missing"
  | "tolerance_too_tight";

export type SendCutSendEnvelopeDecision = {
  eligible: boolean;
  envelopeRevision: typeof SENDCUTSEND_CNC_ENVELOPE_REVISION;
  normalized: {
    accountMode: SendCutSendAccountMode;
    dimensionsInch: [number, number, number] | null;
    fileExtension: string | null;
    finish: "as_machined" | null;
    material: "6061-T6 aluminum" | null;
    process: "cnc_machining" | null;
    quantity: number;
    tightestToleranceInch: number | null;
  };
  denialCodes: SendCutSendEnvelopeDenialCode[];
};

function normalizedFileExtension(fileName: string) {
  const separatorIndex = fileName.lastIndexOf(".");
  if (separatorIndex < 0) {
    return null;
  }

  return fileName.slice(separatorIndex + 1).trim().toLowerCase() || null;
}

function normalizeProcess(process: string | null) {
  if (!process) {
    return null;
  }

  return /\bcnc[\s-]*(?:machining|milling|milled)\b/i.test(process)
    ? ("cnc_machining" as const)
    : null;
}

function normalizeMaterial(material: string) {
  const normalized = material.toLowerCase();
  return normalized.includes("6061") && /alum(?:inum|inium)/.test(normalized)
    ? ("6061-T6 aluminum" as const)
    : null;
}

function normalizeFinish(finish: string | null) {
  if (!finish || !finish.trim()) {
    return "as_machined" as const;
  }

  return /^(?:as[\s-]*machined|none|no finish)$/i.test(finish.trim())
    ? ("as_machined" as const)
    : null;
}

function geometryDimensionsInch(geometry: SendCutSendGeometry | null) {
  if (!geometry?.dimensions || geometry.units === "unsupported") {
    return null;
  }

  const scale = geometry.units === "inch" ? 1 : 1 / 25.4;
  const dimensions = geometry.dimensions.map(
    (dimension) => Math.round(dimension * scale * 1_000_000) / 1_000_000,
  );
  if (dimensions.some((dimension) => !Number.isFinite(dimension) || dimension <= 0)) {
    return null;
  }

  return dimensions.sort((left, right) => left - right) as [number, number, number];
}

function appendGeometryDenials(
  input: SendCutSendEnvelopeInput,
  dimensionsInch: [number, number, number] | null,
  denialCodes: SendCutSendEnvelopeDenialCode[],
) {
  if (!input.geometry) {
    denialCodes.push("geometry_unavailable");
    return;
  }

  if (input.geometry.units === "unsupported") {
    denialCodes.push("geometry_units_unsupported");
  }

  if (input.geometry.solidBodyCount !== 1 || input.geometry.surfaceBodyCount !== 0) {
    denialCodes.push("multiple_or_surface_bodies_unsupported");
  }

  if (!dimensionsInch) {
    denialCodes.push("geometry_dimensions_invalid");
    return;
  }

  const minimum = SENDCUTSEND_CNC_ENVELOPE.minimumDimensionsInch;
  if (dimensionsInch.some((dimension, index) => dimension < minimum[index])) {
    denialCodes.push("geometry_too_small");
  }

  const maximum = SENDCUTSEND_CNC_ENVELOPE.maximumDimensionsInch;
  if (dimensionsInch.some((dimension, index) => dimension > maximum[index])) {
    denialCodes.push("geometry_too_large");
  }
}

/** Evaluates the exact provider-local CNC certification envelope without disclosing files. */
export function evaluateSendCutSendCncEnvelope(
  input: SendCutSendEnvelopeInput,
): SendCutSendEnvelopeDecision {
  const denialCodes: SendCutSendEnvelopeDenialCode[] = [];
  const fileExtension = normalizedFileExtension(input.fileName);
  const process = normalizeProcess(input.process);
  const material = normalizeMaterial(input.material);
  const finish = normalizeFinish(input.finish);
  const dimensionsInch = geometryDimensionsInch(input.geometry);

  if (!fileExtension || !SENDCUTSEND_CNC_ENVELOPE.fileExtensions.includes(fileExtension as "step" | "stp")) {
    denialCodes.push("file_format_unsupported");
  }
  if (!process) denialCodes.push("process_unsupported");
  if (!material) denialCodes.push("material_unsupported");
  if (!finish) denialCodes.push("finish_unsupported");
  if (input.accountMode !== SENDCUTSEND_CNC_ENVELOPE.accountMode) {
    denialCodes.push("account_mode_unsupported");
  }
  if (input.drawingIncluded) denialCodes.push("drawing_not_supported");
  if (!Number.isInteger(input.quantity) || input.quantity < SENDCUTSEND_CNC_ENVELOPE.minimumQuantity) {
    denialCodes.push("quantity_unsupported");
  }
  if (input.tightestToleranceInch === null || !Number.isFinite(input.tightestToleranceInch)) {
    denialCodes.push("tolerance_missing");
  } else if (input.tightestToleranceInch < SENDCUTSEND_CNC_ENVELOPE.standardToleranceInch) {
    denialCodes.push("tolerance_too_tight");
  }

  appendGeometryDenials(input, dimensionsInch, denialCodes);

  return {
    eligible: denialCodes.length === 0,
    envelopeRevision: SENDCUTSEND_CNC_ENVELOPE_REVISION,
    normalized: {
      accountMode: SENDCUTSEND_CNC_ENVELOPE.accountMode,
      dimensionsInch,
      fileExtension,
      finish,
      material,
      process,
      quantity: input.quantity,
      tightestToleranceInch: input.tightestToleranceInch,
    },
    denialCodes,
  };
}

function normalizeGeometryUnits(lengthUnit: string): SendCutSendGeometry["units"] {
  if (lengthUnit === "inch") {
    return "inch";
  }
  if (lengthUnit === "millimeter") {
    return "millimeter";
  }
  return "unsupported";
}

function isCurveOrSurfaceEntityType(entityType: string) {
  if (SUPPORTED_STEP_CURVE_SURFACE_ENTITY_TYPES.has(entityType)) {
    return true;
  }
  if (NON_GEOMETRY_CURVE_ENTITY_TYPES.has(entityType)) {
    return false;
  }
  return entityType.includes("CURVE")
    || entityType.includes("SURFACE")
    || EXPLICIT_CURVE_SURFACE_ENTITY_TYPES.has(entityType);
}

function hasOnlySupportedStepCurveAndSurfaceEntities(stepContent: string) {
  const unquotedContent = stepContent.replace(STEP_QUOTED_STRING_PATTERN, "''");
  const entityTypes = [...unquotedContent.matchAll(STEP_CALL_TYPE_PATTERN)]
    .map((match) => match[1])
    .filter((entityType): entityType is string => Boolean(entityType));
  return entityTypes.every((entityType) => !isCurveOrSurfaceEntityType(entityType)
    || SUPPORTED_STEP_CURVE_SURFACE_ENTITY_TYPES.has(entityType));
}

function hasUnsupportedStepTopology(stepContent: string) {
  return !hasOnlySupportedStepCurveAndSurfaceEntities(stepContent)
    || UNSUPPORTED_STEP_STRUCTURE_PATTERNS.some((pattern) => pattern.test(stepContent));
}

/**
 * Reads deterministic STEP topology and overall dimensions from already-authorized bytes.
 * The canonical text parser does not apply occurrence transforms or evaluate curved extrema,
 * so those shapes fail closed until CAD-kernel metadata is admitted to this quote boundary.
 */
export function inspectSendCutSendStepGeometry(input: {
  fileName: string;
  buffer: Buffer;
}): SendCutSendGeometry | null {
  try {
    const stepContent = input.buffer.toString("utf8");
    if (hasUnsupportedStepTopology(stepContent)) {
      return null;
    }
    const metadata = normalizeStepToCanonicalGeometryMetadata({
      stepContent,
      sourceName: input.fileName,
    });
    if (metadata.edges.some((edge) => edge.curveType !== "LINE")
      || metadata.faces.some((face) => face.surfaceType !== "PLANE")) {
      return null;
    }
    const boundingBox = metadata.boundingBox;
    return {
      units: normalizeGeometryUnits(metadata.units.length),
      solidBodyCount: metadata.summary.solidBodyCount,
      surfaceBodyCount: metadata.summary.surfaceBodyCount,
      dimensions: boundingBox
        ? [boundingBox.size.x, boundingBox.size.y, boundingBox.size.z]
        : null,
    };
  } catch {
    return null;
  }
}
