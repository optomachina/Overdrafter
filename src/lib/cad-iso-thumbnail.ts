import type { OcctMesh } from "occt-import-js";

const MAX_TRIANGLES = 4_000;
const FEATURE_EDGE_DOT_THRESHOLD = Math.cos((32 * Math.PI) / 180);
const CAMERA_DIRECTION = normalizeVector({ x: 1, y: 1, z: 1 });

type Point3 = { x: number; y: number; z: number };
type Point2 = { x: number; y: number };

export type ProjectedCadTriangle = {
  points: [Point2, Point2, Point2];
  edges: Array<[Point2, Point2]>;
  depth: number;
  shade: number;
};

export type ProjectedCadGeometry = {
  triangles: ProjectedCadTriangle[];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
};

/**
 * Projects triangulated CAD meshes into a fixed isometric view that can be
 * painted without keeping a WebGL context alive for every collection row.
 */
export function projectCadMeshesForThumbnail(
  meshes: readonly OcctMesh[],
  maxTriangles = MAX_TRIANGLES,
): ProjectedCadGeometry {
  const totalTriangles = meshes.reduce((total, mesh) => total + Math.floor(mesh.index.array.length / 3), 0);
  const stride = Math.max(1, Math.ceil(totalTriangles / Math.max(maxTriangles, 1)));
  const triangles: Array<ProjectedCadTriangle & { id: number; normal: Point3 }> = [];
  const edgeReferences = new Map<string, Array<{ triangleId: number; start: Point3; end: Point3 }>>();
  const modelScale = calculateModelScale(meshes);
  const quantization = Math.max(modelScale * 1e-7, 1e-9);
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  meshes.forEach((mesh) => {
    const positions = mesh.attributes.position.array;
    const indices = mesh.index.array;

    for (let offset = 0; offset + 2 < indices.length; offset += 3 * stride) {
      const vertices: [Point3, Point3, Point3] = [
        readPoint(positions, indices[offset]),
        readPoint(positions, indices[offset + 1]),
        readPoint(positions, indices[offset + 2]),
      ];
      const points = vertices.map(projectIsometricPoint) as [Point2, Point2, Point2];
      const normal = normalizeVector(calculateNormal(vertices));

      points.forEach((point) => {
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minY = Math.min(minY, point.y);
        maxY = Math.max(maxY, point.y);
      });

      const triangleId = triangles.length;
      triangles.push({
        id: triangleId,
        points,
        edges: [],
        normal,
        depth: vertices.reduce((total, vertex) => total + vertex.x + vertex.y + vertex.z, 0) / 3,
        shade: calculateTriangleShade(vertices),
      });
      if (stride === 1) {
        addEdgeReference(edgeReferences, triangleId, vertices[0], vertices[1], quantization);
        addEdgeReference(edgeReferences, triangleId, vertices[1], vertices[2], quantization);
        addEdgeReference(edgeReferences, triangleId, vertices[2], vertices[0], quantization);
      }
    }
  });

  if (triangles.length === 0) {
    throw new Error("The STEP file did not contain renderable faces.");
  }

  edgeReferences.forEach((references) => {
    if (!isFeatureEdge(triangles, references)) {
      return;
    }

    const [initialOwner, ...remainingReferences] = references;
    if (!initialOwner) {
      return;
    }

    const owner = remainingReferences.reduce((frontmost, candidate) => {
      const frontmostDepth = triangles[frontmost.triangleId]?.depth ?? Number.NEGATIVE_INFINITY;
      const candidateDepth = triangles[candidate.triangleId]?.depth ?? Number.NEGATIVE_INFINITY;
      return candidateDepth > frontmostDepth ? candidate : frontmost;
    }, initialOwner);
    triangles[owner.triangleId]?.edges.push([
      projectIsometricPoint(owner.start),
      projectIsometricPoint(owner.end),
    ]);
  });

  triangles.sort((left, right) => left.depth - right.depth);

  return {
    triangles,
    bounds: { minX, maxX, minY, maxY },
  };
}

function calculateModelScale(meshes: readonly OcctMesh[]): number {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  meshes.forEach((mesh) => {
    const positions = mesh.attributes.position.array;
    for (let offset = 0; offset + 2 < positions.length; offset += 3) {
      minX = Math.min(minX, positions[offset] ?? 0);
      minY = Math.min(minY, positions[offset + 1] ?? 0);
      minZ = Math.min(minZ, positions[offset + 2] ?? 0);
      maxX = Math.max(maxX, positions[offset] ?? 0);
      maxY = Math.max(maxY, positions[offset + 1] ?? 0);
      maxZ = Math.max(maxZ, positions[offset + 2] ?? 0);
    }
  });

  if (!Number.isFinite(minX)) {
    return 1;
  }

  return Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1);
}

function addEdgeReference(
  references: Map<string, Array<{ triangleId: number; start: Point3; end: Point3 }>>,
  triangleId: number,
  start: Point3,
  end: Point3,
  quantization: number,
) {
  const startKey = pointKey(start, quantization);
  const endKey = pointKey(end, quantization);
  const edgeKey = startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`;
  const current = references.get(edgeKey) ?? [];
  current.push({ triangleId, start, end });
  references.set(edgeKey, current);
}

function pointKey(point: Point3, quantization: number): string {
  return [point.x, point.y, point.z]
    .map((coordinate) => Math.round(coordinate / quantization))
    .join(":");
}

function isFeatureEdge(
  triangles: ReadonlyArray<ProjectedCadTriangle & { id: number; normal: Point3 }>,
  references: ReadonlyArray<{ triangleId: number }>,
): boolean {
  if (references.length === 1) {
    return true;
  }

  for (let leftIndex = 0; leftIndex < references.length; leftIndex += 1) {
    const left = triangles[references[leftIndex]?.triangleId ?? -1];
    if (!left) {
      continue;
    }

    for (let rightIndex = leftIndex + 1; rightIndex < references.length; rightIndex += 1) {
      const right = triangles[references[rightIndex]?.triangleId ?? -1];
      if (!right) {
        continue;
      }

      const crease = dotProduct(left.normal, right.normal) < FEATURE_EDGE_DOT_THRESHOLD;
      const leftFacing = dotProduct(left.normal, CAMERA_DIRECTION) >= 0;
      const rightFacing = dotProduct(right.normal, CAMERA_DIRECTION) >= 0;
      if (crease || leftFacing !== rightFacing) {
        return true;
      }
    }
  }

  return false;
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

function calculateTriangleShade([a, b, c]: [Point3, Point3, Point3]): number {
  const normal = calculateNormal([a, b, c]);
  const length = Math.hypot(normal.x, normal.y, normal.z) || 1;
  const light = Math.abs((normal.x * -0.35 + normal.y * 0.82 + normal.z * 0.45) / length);
  return 0.42 + light * 0.48;
}

function calculateNormal([a, b, c]: [Point3, Point3, Point3]): Point3 {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  return {
    x: ab.y * ac.z - ab.z * ac.y,
    y: ab.z * ac.x - ab.x * ac.z,
    z: ab.x * ac.y - ab.y * ac.x,
  };
}

function normalizeVector(vector: Point3): Point3 {
  const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

function dotProduct(left: Point3, right: Point3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}
