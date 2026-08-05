import fs from "node:fs/promises";
import occtImportJs, { type OcctMesh, type OcctModule } from "occt-import-js";

export const CAD_PREVIEW_DISPLAY_STYLE = "sketch" as const;
export const CAD_PREVIEW_ORIENTATION = "isometric" as const;
export const CAD_PREVIEW_RENDERER_VERSION = "cad-svg-sketch-v1";
export const CAD_PREVIEW_CONTENT_TYPE = "image/svg+xml";
export const CAD_PREVIEW_SIZE = 256;

const MAX_RENDER_TRIANGLES = 25_000;
const FEATURE_EDGE_ANGLE_RADIANS = (32 * Math.PI) / 180;
const FEATURE_EDGE_DOT_THRESHOLD = Math.cos(FEATURE_EDGE_ANGLE_RADIANS);
const CAMERA_DIRECTION = normalizeVector({ x: 1, y: 1, z: 1 });
const LIGHT_DIRECTION = normalizeVector({ x: -0.35, y: 0.82, z: 0.45 });

type Point3 = { x: number; y: number; z: number };
type Point2 = { x: number; y: number };

type RenderTriangle = {
  id: number;
  vertices: [Point3, Point3, Point3];
  points: [Point2, Point2, Point2];
  normal: Point3;
  depth: number;
  shade: number;
  visible: boolean;
};

type EdgeReference = {
  triangleId: number;
  start: Point3;
  end: Point3;
};

type RenderEdge = {
  start: Point2;
  end: Point2;
};

export type CadPreviewRender = {
  content: Buffer;
  contentType: typeof CAD_PREVIEW_CONTENT_TYPE;
  displayStyle: typeof CAD_PREVIEW_DISPLAY_STYLE;
  viewOrientation: typeof CAD_PREVIEW_ORIENTATION;
  rendererVersion: string;
  width: number;
  height: number;
  triangleCount: number;
  featureEdgeCount: number;
};

let occtModulePromise: Promise<OcctModule> | null = null;

/**
 * Triangulates a STEP file and renders a deterministic isometric sketch with
 * tessellation seams suppressed and only boundary/crease edges retained.
 */
export async function renderCadPreviewFromStepFile(filePath: string): Promise<CadPreviewRender> {
  const [occt, fileContent] = await Promise.all([
    getOcctModule(),
    fs.readFile(filePath),
  ]);
  const result = occt.ReadStepFile(new Uint8Array(fileContent), {
    linearUnit: "millimeter",
    linearDeflectionType: "bounding_box_ratio",
    linearDeflection: 0.008,
    angularDeflection: 0.5,
  });

  if (!result.success || result.meshes.length === 0) {
    throw new Error("The STEP file could not be triangulated for a CAD preview.");
  }

  return renderCadMeshesToSvg(result.meshes);
}

/** Renders already-triangulated CAD meshes for unit tests and worker reuse. */
export function renderCadMeshesToSvg(meshes: readonly OcctMesh[]): CadPreviewRender {
  const triangleCount = meshes.reduce(
    (total, mesh) => total + Math.floor(mesh.index.array.length / 3),
    0,
  );

  if (triangleCount === 0) {
    throw new Error("The CAD model did not contain renderable faces.");
  }

  if (triangleCount > MAX_RENDER_TRIANGLES) {
    throw new Error(
      `The CAD model contains ${triangleCount} preview triangles, exceeding the ${MAX_RENDER_TRIANGLES} triangle limit.`,
    );
  }

  const modelBounds = calculateModelBounds(meshes);
  const quantization = Math.max(modelBounds.maxDimension * 1e-7, 1e-9);
  const triangles: RenderTriangle[] = [];
  const edgeReferences = new Map<string, EdgeReference[]>();

  for (const mesh of meshes) {
    const positions = mesh.attributes.position.array;
    const indices = mesh.index.array;

    for (let offset = 0; offset + 2 < indices.length; offset += 3) {
      const vertices: [Point3, Point3, Point3] = [
        readPoint(positions, indices[offset]),
        readPoint(positions, indices[offset + 1]),
        readPoint(positions, indices[offset + 2]),
      ];
      const normal = calculateNormal(vertices);
      const normalLength = vectorLength(normal);

      if (normalLength <= Number.EPSILON) {
        continue;
      }

      const normalizedNormal = scaleVector(normal, 1 / normalLength);
      const triangleId = triangles.length;
      const triangle: RenderTriangle = {
        id: triangleId,
        vertices,
        points: vertices.map(projectIsometricPoint) as [Point2, Point2, Point2],
        normal: normalizedNormal,
        depth: average(vertices.map((vertex) => dotProduct(vertex, CAMERA_DIRECTION))),
        shade: 0.55 + Math.abs(dotProduct(normalizedNormal, LIGHT_DIRECTION)) * 0.4,
        visible: dotProduct(normalizedNormal, CAMERA_DIRECTION) > 1e-8,
      };
      triangles.push(triangle);

      addEdgeReference(edgeReferences, triangleId, vertices[0], vertices[1], quantization);
      addEdgeReference(edgeReferences, triangleId, vertices[1], vertices[2], quantization);
      addEdgeReference(edgeReferences, triangleId, vertices[2], vertices[0], quantization);
    }
  }

  if (triangles.length === 0) {
    throw new Error("The CAD model did not contain non-degenerate preview faces.");
  }

  let visibleTriangles = triangles.filter((triangle) => triangle.visible);
  if (visibleTriangles.length === 0) {
    triangles.forEach((triangle) => {
      triangle.visible = true;
    });
    visibleTriangles = [...triangles];
  }

  const edgesByTriangle = assignVisibleFeatureEdges(triangles, edgeReferences);
  const svg = buildSvg(visibleTriangles, edgesByTriangle);
  const featureEdgeCount = [...edgesByTriangle.values()].reduce(
    (total, edges) => total + edges.length,
    0,
  );

  return {
    content: Buffer.from(svg, "utf8"),
    contentType: CAD_PREVIEW_CONTENT_TYPE,
    displayStyle: CAD_PREVIEW_DISPLAY_STYLE,
    viewOrientation: CAD_PREVIEW_ORIENTATION,
    rendererVersion: CAD_PREVIEW_RENDERER_VERSION,
    width: CAD_PREVIEW_SIZE,
    height: CAD_PREVIEW_SIZE,
    triangleCount: visibleTriangles.length,
    featureEdgeCount,
  };
}

function getOcctModule(): Promise<OcctModule> {
  occtModulePromise ??= occtImportJs();

  return occtModulePromise;
}

function calculateModelBounds(meshes: readonly OcctMesh[]) {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  meshes.forEach((mesh) => {
    const positions = mesh.attributes.position.array;
    for (let offset = 0; offset + 2 < positions.length; offset += 3) {
      const x = positions[offset] ?? 0;
      const y = positions[offset + 1] ?? 0;
      const z = positions[offset + 2] ?? 0;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
    }
  });

  return {
    maxDimension: Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1),
  };
}

function addEdgeReference(
  references: Map<string, EdgeReference[]>,
  triangleId: number,
  start: Point3,
  end: Point3,
  quantization: number,
) {
  const startKey = quantizedPointKey(start, quantization);
  const endKey = quantizedPointKey(end, quantization);
  const edgeKey = startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`;
  const current = references.get(edgeKey) ?? [];
  current.push({ triangleId, start, end });
  references.set(edgeKey, current);
}

function assignVisibleFeatureEdges(
  triangles: readonly RenderTriangle[],
  references: ReadonlyMap<string, EdgeReference[]>,
): Map<number, RenderEdge[]> {
  const edgesByTriangle = new Map<number, RenderEdge[]>();

  references.forEach((edgeReferences) => {
    if (!isFeatureEdge(triangles, edgeReferences)) {
      return;
    }

    const visibleReferences = edgeReferences.filter(
      (reference) => triangles[reference.triangleId]?.visible,
    );
    if (visibleReferences.length === 0) {
      return;
    }

    const [initialOwner, ...remainingReferences] = visibleReferences;
    if (!initialOwner) {
      return;
    }

    const owner = remainingReferences.reduce((frontmost, candidate) => {
      const frontmostDepth = triangles[frontmost.triangleId]?.depth ?? Number.NEGATIVE_INFINITY;
      const candidateDepth = triangles[candidate.triangleId]?.depth ?? Number.NEGATIVE_INFINITY;
      return candidateDepth > frontmostDepth ? candidate : frontmost;
    }, initialOwner);
    const current = edgesByTriangle.get(owner.triangleId) ?? [];
    current.push({
      start: projectIsometricPoint(owner.start),
      end: projectIsometricPoint(owner.end),
    });
    edgesByTriangle.set(owner.triangleId, current);
  });

  return edgesByTriangle;
}

function isFeatureEdge(
  triangles: readonly RenderTriangle[],
  references: readonly EdgeReference[],
): boolean {
  if (references.length === 1) {
    return true;
  }

  for (let leftIndex = 0; leftIndex < references.length; leftIndex += 1) {
    const leftTriangle = triangles[references[leftIndex]?.triangleId ?? -1];
    if (!leftTriangle) {
      continue;
    }

    for (let rightIndex = leftIndex + 1; rightIndex < references.length; rightIndex += 1) {
      const rightTriangle = triangles[references[rightIndex]?.triangleId ?? -1];
      if (
        rightTriangle &&
        dotProduct(leftTriangle.normal, rightTriangle.normal) < FEATURE_EDGE_DOT_THRESHOLD
      ) {
        return true;
      }
    }
  }

  return false;
}

function buildSvg(
  triangles: readonly RenderTriangle[],
  edgesByTriangle: ReadonlyMap<number, RenderEdge[]>,
): string {
  const sortedTriangles = [...triangles].sort((left, right) => left.depth - right.depth);
  const projectedPoints = sortedTriangles.flatMap((triangle) => triangle.points);
  const minX = Math.min(...projectedPoints.map((point) => point.x));
  const maxX = Math.max(...projectedPoints.map((point) => point.x));
  const minY = Math.min(...projectedPoints.map((point) => point.y));
  const maxY = Math.max(...projectedPoints.map((point) => point.y));
  const padding = 18;
  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  const scale = Math.min(
    (CAD_PREVIEW_SIZE - padding * 2) / width,
    (CAD_PREVIEW_SIZE - padding * 2) / height,
  );
  const offsetX = (CAD_PREVIEW_SIZE - width * scale) / 2 - minX * scale;
  const offsetY = (CAD_PREVIEW_SIZE - height * scale) / 2 - minY * scale;
  const body = sortedTriangles.map((triangle) => {
    const path = closedPath(triangle.points, scale, offsetX, offsetY);
    const lightness = Math.round(84 + triangle.shade * 11);
    const face = `<path d="${path}" fill="hsl(38 20% ${lightness}%)"/>`;
    const edges = (edgesByTriangle.get(triangle.id) ?? []).map((edge) => {
      const start = transformPoint(edge.start, scale, offsetX, offsetY);
      const end = transformPoint(edge.end, scale, offsetX, offsetY);
      const edgePath = `M${formatPoint(start)}L${formatPoint(end)}`;
      return [
        `<path d="${edgePath}" fill="none" stroke="#49453e" stroke-width="1.05" stroke-linecap="round" stroke-linejoin="round"/>`,
        `<path d="${edgePath}" transform="translate(0.42 -0.28)" fill="none" stroke="#756f64" stroke-width="0.52" stroke-linecap="round" stroke-dasharray="1.15 0.72" opacity="0.5"/>`,
      ].join("");
    });
    return [face, ...edges].join("");
  });

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CAD_PREVIEW_SIZE} ${CAD_PREVIEW_SIZE}" width="${CAD_PREVIEW_SIZE}" height="${CAD_PREVIEW_SIZE}" role="img" aria-label="Isometric CAD sketch preview">`,
    `<g shape-rendering="geometricPrecision">${body.join("")}</g>`,
    `</svg>`,
  ].join("");
}

function closedPath(
  points: readonly Point2[],
  scale: number,
  offsetX: number,
  offsetY: number,
): string {
  const [first, ...rest] = points.map((point) => transformPoint(point, scale, offsetX, offsetY));
  if (!first) {
    return "";
  }

  const remainingPath = rest.map((point) => `L${formatPoint(point)}`).join("");
  return `M${formatPoint(first)}${remainingPath}Z`;
}

function transformPoint(point: Point2, scale: number, offsetX: number, offsetY: number): Point2 {
  return {
    x: point.x * scale + offsetX,
    y: point.y * scale + offsetY,
  };
}

function formatPoint(point: Point2): string {
  return `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
}

function readPoint(positions: ArrayLike<number>, index: number): Point3 {
  const offset = index * 3;
  return {
    x: positions[offset] ?? 0,
    y: positions[offset + 1] ?? 0,
    z: positions[offset + 2] ?? 0,
  };
}

function projectIsometricPoint(point: Point3): Point2 {
  return {
    x: (point.x - point.z) * 0.8660254,
    y: (point.x + point.z) * 0.5 - point.y,
  };
}

function calculateNormal([a, b, c]: [Point3, Point3, Point3]): Point3 {
  const ab = subtractVectors(b, a);
  const ac = subtractVectors(c, a);
  return {
    x: ab.y * ac.z - ab.z * ac.y,
    y: ab.z * ac.x - ab.x * ac.z,
    z: ab.x * ac.y - ab.y * ac.x,
  };
}

function quantizedPointKey(point: Point3, quantization: number): string {
  return [point.x, point.y, point.z]
    .map((coordinate) => Math.round(coordinate / quantization))
    .join(":");
}

function subtractVectors(left: Point3, right: Point3): Point3 {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z,
  };
}

function scaleVector(vector: Point3, scale: number): Point3 {
  return {
    x: vector.x * scale,
    y: vector.y * scale,
    z: vector.z * scale,
  };
}

function dotProduct(left: Point3, right: Point3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function vectorLength(vector: Point3): number {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function normalizeVector(vector: Point3): Point3 {
  const length = vectorLength(vector) || 1;
  return scaleVector(vector, 1 / length);
}

function average(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}
