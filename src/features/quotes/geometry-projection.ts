export type GeometryPrimitiveType = "box" | "cylinder" | "hole" | "cutout";

export type GeometryProjectionFeature = {
  id: string;
  label: string;
  featureClass: GeometryPrimitiveType;
  confidence: number;
  riskFlags: string[];
};

export type GeometryProjectionPrimitive = {
  id: string;
  type: GeometryPrimitiveType;
  x: number;
  y: number;
  width: number;
  height: number;
  featureId: string;
};

export type GeometryProjection = {
  schemaVersion: string;
  extractorVersion: string;
  features: GeometryProjectionFeature[];
  primitives: GeometryProjectionPrimitive[];
};

export function parseGeometryProjection(input: unknown): GeometryProjection | null {
  const payload = asObject(input);
  const projection = asObject(payload.geometryProjection);
  if (!projection.schemaVersion || !projection.extractorVersion) {
    return null;
  }

  const features = asArray<Record<string, unknown>>(projection.features)
    .map((feature) => {
      const featureClass = asString(feature.featureClass);
      if (!featureClass || !isPrimitiveType(featureClass)) {
        return null;
      }

      return {
        id: asString(feature.id) ?? "",
        label: asString(feature.label) ?? featureClass,
        featureClass,
        confidence: asNumber(feature.confidence),
        riskFlags: asArray<string>(feature.riskFlags),
      } satisfies GeometryProjectionFeature;
    })
    .filter((feature): feature is GeometryProjectionFeature => Boolean(feature?.id));

  const primitives = asArray<Record<string, unknown>>(projection.primitives)
    .map((primitive) => {
      const type = asString(primitive.type);
      if (!type || !isPrimitiveType(type)) {
        return null;
      }

      return {
        id: asString(primitive.id) ?? "",
        type,
        x: asNumber(primitive.x),
        y: asNumber(primitive.y),
        width: Math.max(0, asNumber(primitive.width)),
        height: Math.max(0, asNumber(primitive.height)),
        featureId: asString(primitive.featureId) ?? "",
      } satisfies GeometryProjectionPrimitive;
    })
    .filter((primitive): primitive is GeometryProjectionPrimitive => Boolean(primitive?.id && primitive.featureId));

  if (features.length === 0 || primitives.length === 0) {
    return null;
  }

  return {
    schemaVersion: asString(projection.schemaVersion) ?? "v1",
    extractorVersion: asString(projection.extractorVersion) ?? "unknown",
    features,
    primitives,
  };
}

function isPrimitiveType(value: string): value is GeometryPrimitiveType {
  return value === "box" || value === "cylinder" || value === "hole" || value === "cutout";
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
