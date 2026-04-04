export const CANONICAL_PART_GEOMETRY_SCHEMA_VERSION = "canonical-part-geometry.v1";

export type CanonicalLengthUnit =
  | "millimeter"
  | "centimeter"
  | "meter"
  | "inch"
  | "foot"
  | "unknown";

export type Vector3 = {
  x: number;
  y: number;
  z: number;
};

export type BoundingBox3 = {
  min: Vector3;
  max: Vector3;
  size: Vector3;
};

export type StepSourceMetadata = {
  declaredName: string | null;
  timestamp: string | null;
  authors: string[];
  organizations: string[];
  preprocessorVersion: string | null;
  originatingSystem: string | null;
  authorization: string | null;
  schemaIdentifiers: string[];
  description: string[];
  productNames: string[];
};

export type CanonicalOrientedEdgeReference = {
  edgeId: string;
  orientation: "forward" | "reversed" | "unknown";
};

export type CanonicalVertexGeometry = {
  id: string;
  sourceEntityId: string;
  position: Vector3;
};

export type CanonicalEdgeGeometry = {
  id: string;
  sourceEntityId: string;
  startVertexId: string | null;
  endVertexId: string | null;
  curveType: string | null;
};

export type CanonicalFaceBound = {
  kind: "outer" | "inner" | "unknown";
  orientedEdges: CanonicalOrientedEdgeReference[];
  edgeIds: string[];
};

export type CanonicalFaceGeometry = {
  id: string;
  sourceEntityId: string;
  surfaceType: string | null;
  orientation: boolean | null;
  bounds: CanonicalFaceBound[];
  edgeIds: string[];
  vertexIds: string[];
};

export type CanonicalShellGeometry = {
  id: string;
  sourceEntityId: string;
  closure: "closed" | "open" | "unknown";
  faceIds: string[];
};

export type CanonicalBodyGeometry = {
  id: string;
  sourceEntityId: string;
  kind: "solid" | "surface";
  shellIds: string[];
  faceIds: string[];
  edgeIds: string[];
  vertexIds: string[];
  boundingBox: BoundingBox3 | null;
};

export type CanonicalPartGeometryMetadata = {
  schemaVersion: typeof CANONICAL_PART_GEOMETRY_SCHEMA_VERSION;
  sourceFormat: "step";
  sourceName: string | null;
  source: StepSourceMetadata;
  units: {
    length: CanonicalLengthUnit;
    raw: string | null;
  };
  summary: {
    sourceEntityCount: number;
    bodyCount: number;
    solidBodyCount: number;
    surfaceBodyCount: number;
    shellCount: number;
    faceCount: number;
    edgeCount: number;
    vertexCount: number;
  };
  boundingBox: BoundingBox3 | null;
  vertices: CanonicalVertexGeometry[];
  edges: CanonicalEdgeGeometry[];
  faces: CanonicalFaceGeometry[];
  shells: CanonicalShellGeometry[];
  bodies: CanonicalBodyGeometry[];
};

type StepEntity = {
  sourceEntityId: string;
  sourceEntityNumericId: number;
  type: string;
  args: string | null;
  rawValue: string;
};

type ParsedVertex = {
  sourceEntityId: string;
  cartesianPointRef: string | null;
};

type ParsedEdge = {
  sourceEntityId: string;
  startVertexRef: string | null;
  endVertexRef: string | null;
  curveRef: string | null;
};

type ParsedOrientedEdge = {
  edgeRef: string | null;
  orientation: "forward" | "reversed" | "unknown";
};

type ParsedFaceBound = {
  kind: "outer" | "inner" | "unknown";
  loopRef: string | null;
};

type ParsedFace = {
  sourceEntityId: string;
  boundRefs: string[];
  surfaceRef: string | null;
  orientation: boolean | null;
};

type ParsedShell = {
  sourceEntityId: string;
  closure: "closed" | "open" | "unknown";
  faceRefs: string[];
};

type ParsedBody = {
  sourceEntityId: string;
  kind: "solid" | "surface";
  shellRefs: string[];
};

type ParsedTopology = {
  cartesianPoints: Map<string, Vector3>;
  parsedVertices: Map<string, ParsedVertex>;
  parsedEdges: Map<string, ParsedEdge>;
  parsedOrientedEdges: Map<string, ParsedOrientedEdge>;
  parsedEdgeLoops: Map<string, string[]>;
  parsedFaceBounds: Map<string, ParsedFaceBound>;
  parsedFaces: Map<string, ParsedFace>;
  parsedShells: Map<string, ParsedShell>;
  parsedBodies: Map<string, ParsedBody>;
};

type MaterializedVertices = {
  vertices: CanonicalVertexGeometry[];
  vertexIdBySource: Map<string, string>;
  vertexById: Map<string, CanonicalVertexGeometry>;
};

function splitTopLevel(value: string, delimiter = ","): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let inString = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const next = value[index + 1];

    if (character === "'") {
      current += character;
      if (inString && next === "'") {
        current += next;
        index += 1;
        continue;
      }

      inString = !inString;
      continue;
    }

    if (!inString) {
      if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth = Math.max(0, depth - 1);
      } else if (character === delimiter && depth === 0) {
        parts.push(current.trim());
        current = "";
        continue;
      }
    }

    current += character;
  }

  if (current.trim().length > 0) {
    parts.push(current.trim());
  }

  return parts;
}

function parseQuotedString(token: string | undefined): string | null {
  if (!token) {
    return null;
  }

  const trimmed = token.trim();
  if (trimmed === "$" || trimmed === "*") {
    return null;
  }

  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }

  return trimmed.length > 0 ? trimmed : null;
}

function parseStringList(token: string | undefined): string[] {
  if (!token) {
    return [];
  }

  const trimmed = token.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) {
    return [];
  }

  return splitTopLevel(trimmed.slice(1, -1))
    .map((entry) => parseQuotedString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function parseReference(token: string | undefined): string | null {
  if (!token) {
    return null;
  }

  const match = token.trim().match(/#\d+/);
  return match ? match[0] : null;
}

function parseReferenceList(token: string | undefined): string[] {
  if (!token) {
    return [];
  }

  const matches = token.match(/#\d+/g);
  return matches ? matches : [];
}

function parseBooleanToken(token: string | undefined): boolean | null {
  if (!token) {
    return null;
  }

  const normalized = token.trim().toUpperCase();
  if (normalized === ".T.") {
    return true;
  }

  if (normalized === ".F.") {
    return false;
  }

  return null;
}

function parseTupleNumbers(token: string | undefined): number[] {
  if (!token) {
    return [];
  }

  const start = token.indexOf("(");
  const end = token.lastIndexOf(")");
  if (start < 0 || end <= start) {
    return [];
  }

  return token
    .slice(start + 1, end)
    .split(",")
    .map((entry) => Number.parseFloat(entry.trim()))
    .filter((entry) => Number.isFinite(entry));
}

function compareStepEntityRefs(left: string, right: string) {
  return Number.parseInt(left.slice(1), 10) - Number.parseInt(right.slice(1), 10);
}

function uniquePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }

    seen.add(value);
    result.push(value);
  }

  return result;
}

function buildBoundingBox(points: Vector3[]): BoundingBox3 | null {
  if (points.length === 0) {
    return null;
  }

  const min = { ...points[0]! };
  const max = { ...points[0]! };

  for (const point of points.slice(1)) {
    min.x = Math.min(min.x, point.x);
    min.y = Math.min(min.y, point.y);
    min.z = Math.min(min.z, point.z);
    max.x = Math.max(max.x, point.x);
    max.y = Math.max(max.y, point.y);
    max.z = Math.max(max.z, point.z);
  }

  return {
    min,
    max,
    size: {
      x: max.x - min.x,
      y: max.y - min.y,
      z: max.z - min.z,
    },
  };
}

function makeCanonicalId(prefix: string, index: number) {
  return `${prefix}-${String(index + 1).padStart(3, "0")}`;
}

function extractSection(stepContent: string, sectionName: "HEADER" | "DATA") {
  const match = stepContent.match(new RegExp(`${sectionName};([\\s\\S]*?)ENDSEC;`, "i"));
  return match?.[1] ?? "";
}

function tokenizeStepStatements(dataSection: string): string[] {
  const statements: string[] = [];
  let current = "";
  let collecting = false;
  let depth = 0;
  let inString = false;

  for (let index = 0; index < dataSection.length; index += 1) {
    const character = dataSection[index]!;
    const next = dataSection[index + 1];

    if (!collecting) {
      if (character === "#") {
        collecting = true;
        current = character;
        depth = 0;
        inString = false;
      }
      continue;
    }

    current += character;

    if (character === "'") {
      if (inString && next === "'") {
        current += next;
        index += 1;
        continue;
      }

      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (character === "(") {
      depth += 1;
      continue;
    }

    if (character === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (character === ";" && depth === 0) {
      statements.push(current.slice(0, -1).trim());
      current = "";
      collecting = false;
    }
  }

  return statements;
}

function parseStepStatement(statement: string): StepEntity | null {
  const equalsIndex = statement.indexOf("=");
  if (!statement.startsWith("#") || equalsIndex <= 1) {
    return null;
  }

  const sourceEntityNumericId = Number.parseInt(statement.slice(1, equalsIndex).trim(), 10);
  if (!Number.isFinite(sourceEntityNumericId)) {
    return null;
  }

  const sourceEntityId = `#${sourceEntityNumericId}`;
  const rawValue = statement.slice(equalsIndex + 1).trim();

  if (rawValue.startsWith("(")) {
    return {
      sourceEntityId,
      sourceEntityNumericId,
      type: "COMPLEX_ENTITY",
      args: null,
      rawValue,
    };
  }

  const callMatch = /^([A-Z0-9_]+)\s*\(([\s\S]*)\)$/.exec(rawValue);
  if (!callMatch) {
    return {
      sourceEntityId,
      sourceEntityNumericId,
      type: "UNKNOWN",
      args: null,
      rawValue,
    };
  }

  return {
    sourceEntityId,
    sourceEntityNumericId,
    type: callMatch[1],
    args: callMatch[2],
    rawValue,
  };
}

function parseStepEntities(dataSection: string): StepEntity[] {
  const entities = tokenizeStepStatements(dataSection)
    .map((statement) => parseStepStatement(statement))
    .filter((entity): entity is StepEntity => entity !== null);

  return entities.sort((left, right) => left.sourceEntityNumericId - right.sourceEntityNumericId);
}

function createParsedTopology(): ParsedTopology {
  return {
    cartesianPoints: new Map<string, Vector3>(),
    parsedVertices: new Map<string, ParsedVertex>(),
    parsedEdges: new Map<string, ParsedEdge>(),
    parsedOrientedEdges: new Map<string, ParsedOrientedEdge>(),
    parsedEdgeLoops: new Map<string, string[]>(),
    parsedFaceBounds: new Map<string, ParsedFaceBound>(),
    parsedFaces: new Map<string, ParsedFace>(),
    parsedShells: new Map<string, ParsedShell>(),
    parsedBodies: new Map<string, ParsedBody>(),
  };
}

function parseOrientedEdgeOrientation(token: string | undefined): ParsedOrientedEdge["orientation"] {
  const orientation = parseBooleanToken(token);
  if (orientation === true) {
    return "forward";
  }

  if (orientation === false) {
    return "reversed";
  }

  return "unknown";
}

function captureTopologyEntity(entity: StepEntity, topology: ParsedTopology) {
  const args = splitTopLevel(entity.args ?? "");

  switch (entity.type) {
    case "CARTESIAN_POINT": {
      const numbers = parseTupleNumbers(args[1]);
      if (numbers.length >= 3) {
        topology.cartesianPoints.set(entity.sourceEntityId, {
          x: numbers[0]!,
          y: numbers[1]!,
          z: numbers[2]!,
        });
      }
      break;
    }
    case "VERTEX_POINT": {
      topology.parsedVertices.set(entity.sourceEntityId, {
        sourceEntityId: entity.sourceEntityId,
        cartesianPointRef: parseReference(args[1]),
      });
      break;
    }
    case "EDGE_CURVE": {
      topology.parsedEdges.set(entity.sourceEntityId, {
        sourceEntityId: entity.sourceEntityId,
        startVertexRef: parseReference(args[1]),
        endVertexRef: parseReference(args[2]),
        curveRef: parseReference(args[3]),
      });
      break;
    }
    case "ORIENTED_EDGE": {
      topology.parsedOrientedEdges.set(entity.sourceEntityId, {
        edgeRef: parseReference(args[3]),
        orientation: parseOrientedEdgeOrientation(args[4]),
      });
      break;
    }
    case "EDGE_LOOP": {
      topology.parsedEdgeLoops.set(entity.sourceEntityId, parseReferenceList(args[1]));
      break;
    }
    case "FACE_BOUND":
    case "FACE_OUTER_BOUND": {
      topology.parsedFaceBounds.set(entity.sourceEntityId, {
        kind: entity.type === "FACE_OUTER_BOUND" ? "outer" : "inner",
        loopRef: parseReference(args[1]),
      });
      break;
    }
    case "ADVANCED_FACE": {
      topology.parsedFaces.set(entity.sourceEntityId, {
        sourceEntityId: entity.sourceEntityId,
        boundRefs: parseReferenceList(args[1]),
        surfaceRef: parseReference(args[2]),
        orientation: parseBooleanToken(args[3]),
      });
      break;
    }
    case "CLOSED_SHELL":
    case "OPEN_SHELL": {
      topology.parsedShells.set(entity.sourceEntityId, {
        sourceEntityId: entity.sourceEntityId,
        closure: entity.type === "CLOSED_SHELL" ? "closed" : "open",
        faceRefs: parseReferenceList(args[1]),
      });
      break;
    }
    case "MANIFOLD_SOLID_BREP":
    case "FACETED_BREP": {
      topology.parsedBodies.set(entity.sourceEntityId, {
        sourceEntityId: entity.sourceEntityId,
        kind: "solid",
        shellRefs: parseReferenceList(args[1]),
      });
      break;
    }
    case "SHELL_BASED_SURFACE_MODEL": {
      topology.parsedBodies.set(entity.sourceEntityId, {
        sourceEntityId: entity.sourceEntityId,
        kind: "surface",
        shellRefs: parseReferenceList(args[1]),
      });
      break;
    }
    default:
      break;
  }
}

function ensureBodiesForShells(parsedShells: Map<string, ParsedShell>, parsedBodies: Map<string, ParsedBody>) {
  if (parsedBodies.size > 0 || parsedShells.size === 0) {
    return;
  }

  for (const shell of [...parsedShells.values()].sort((left, right) =>
    compareStepEntityRefs(left.sourceEntityId, right.sourceEntityId),
  )) {
    parsedBodies.set(shell.sourceEntityId, {
      sourceEntityId: shell.sourceEntityId,
      kind: shell.closure === "closed" ? "solid" : "surface",
      shellRefs: [shell.sourceEntityId],
    });
  }
}

function collectParsedTopology(entities: StepEntity[]): ParsedTopology {
  const topology = createParsedTopology();

  for (const entity of entities) {
    captureTopologyEntity(entity, topology);
  }

  ensureBodiesForShells(topology.parsedShells, topology.parsedBodies);
  return topology;
}

function buildCanonicalIdMap(sourceEntityIds: Iterable<string>, prefix: string) {
  return new Map(
    [...sourceEntityIds]
      .sort(compareStepEntityRefs)
      .map((sourceEntityId, index) => [sourceEntityId, makeCanonicalId(prefix, index)]),
  );
}

function parseHeaderMetadata(headerSection: string, entities: StepEntity[]): StepSourceMetadata {
  const fileNameMatch = headerSection.match(/FILE_NAME\(([\s\S]*?)\)\s*;/i);
  const fileNameArgs = fileNameMatch ? splitTopLevel(fileNameMatch[1]!) : [];
  const fileSchemaMatch = headerSection.match(/FILE_SCHEMA\(([\s\S]*?)\)\s*;/i);
  const fileDescriptionMatch = headerSection.match(/FILE_DESCRIPTION\(([\s\S]*?)\)\s*;/i);

  const productNames = entities
    .filter((entity) => entity.type === "PRODUCT")
    .map((entity) => parseQuotedString(splitTopLevel(entity.args ?? "")[1]))
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => left.localeCompare(right));

  return {
    declaredName: parseQuotedString(fileNameArgs[0]),
    timestamp: parseQuotedString(fileNameArgs[1]),
    authors: parseStringList(fileNameArgs[2]),
    organizations: parseStringList(fileNameArgs[3]),
    preprocessorVersion: parseQuotedString(fileNameArgs[4]),
    originatingSystem: parseQuotedString(fileNameArgs[5]),
    authorization: parseQuotedString(fileNameArgs[6]),
    schemaIdentifiers: fileSchemaMatch ? parseStringList(fileSchemaMatch[1]) : [],
    description: fileDescriptionMatch ? parseStringList(splitTopLevel(fileDescriptionMatch[1]!)[0]) : [],
    productNames,
  };
}

function parseLengthUnit(entities: StepEntity[]) {
  let fallbackRaw: string | null = null;

  for (const entity of entities) {
    const rawUpper = entity.rawValue.toUpperCase();

    if (rawUpper.includes("LENGTH_UNIT") && rawUpper.includes("SI_UNIT")) {
      const siMatch = /SI_UNIT\((\.[A-Z]+\.)?\s*,\s*(\.[A-Z]+\.)\)/i.exec(entity.rawValue);
      if (!siMatch) {
        continue;
      }

      const prefix = (siMatch[1] ?? "").toUpperCase();
      const base = siMatch[2].toUpperCase();

      if (base === ".METRE.") {
        if (prefix === ".MILLI.") {
          return { length: "millimeter" as const, raw: "SI_UNIT(.MILLI.,.METRE.)" };
        }

        if (prefix === ".CENTI.") {
          return { length: "centimeter" as const, raw: "SI_UNIT(.CENTI.,.METRE.)" };
        }

        return { length: "meter" as const, raw: `SI_UNIT(${prefix || "$"},.METRE.)` };
      }
    }

    if (!rawUpper.includes("LENGTH_UNIT")) {
      continue;
    }

    const conversionMatch = /CONVERSION_BASED_UNIT\(\s*'([^']+)'/i.exec(entity.rawValue);
    if (!conversionMatch) {
      continue;
    }

    const normalized = conversionMatch[1].trim().toLowerCase();
    if (normalized === "inch" || normalized === "inches") {
      return { length: "inch" as const, raw: conversionMatch[0] };
    }

    if (normalized === "foot" || normalized === "feet") {
      return { length: "foot" as const, raw: conversionMatch[0] };
    }

    fallbackRaw = conversionMatch[0];
  }

  return { length: "unknown" as const, raw: fallbackRaw };
}

function materializeVertices(
  parsedVertices: Map<string, ParsedVertex>,
  cartesianPoints: Map<string, Vector3>,
): MaterializedVertices {
  const vertices = [...parsedVertices.values()]
    .sort((left, right) => compareStepEntityRefs(left.sourceEntityId, right.sourceEntityId))
    .reduce<CanonicalVertexGeometry[]>((result, vertex) => {
      const point = vertex.cartesianPointRef ? cartesianPoints.get(vertex.cartesianPointRef) : null;
      if (!point) {
        return result;
      }

      result.push({
        id: makeCanonicalId("vertex", result.length),
        sourceEntityId: vertex.sourceEntityId,
        position: point,
      });
      return result;
    }, []);
  const vertexIdBySource = new Map(vertices.map((vertex) => [vertex.sourceEntityId, vertex.id]));
  const vertexById = new Map(vertices.map((vertex) => [vertex.id, vertex]));
  return { vertices, vertexIdBySource, vertexById };
}

function materializeEdges(
  parsedEdges: Map<string, ParsedEdge>,
  edgeIdBySource: Map<string, string>,
  vertexIdBySource: Map<string, string>,
  entityById: Map<string, StepEntity>,
): CanonicalEdgeGeometry[] {
  return [...parsedEdges.values()]
    .sort((left, right) => compareStepEntityRefs(left.sourceEntityId, right.sourceEntityId))
    .map((edge) => ({
      id: edgeIdBySource.get(edge.sourceEntityId)!,
      sourceEntityId: edge.sourceEntityId,
      startVertexId: edge.startVertexRef ? vertexIdBySource.get(edge.startVertexRef) ?? null : null,
      endVertexId: edge.endVertexRef ? vertexIdBySource.get(edge.endVertexRef) ?? null : null,
      curveType: edge.curveRef ? entityById.get(edge.curveRef)?.type ?? null : null,
    }));
}

function collectVertexIdsFromEdges(edgeIds: string[], edgeById: Map<string, CanonicalEdgeGeometry>) {
  return uniquePreserveOrder(
    edgeIds.flatMap((edgeId) => {
      const edge = edgeById.get(edgeId);
      return [edge?.startVertexId ?? null, edge?.endVertexId ?? null].filter(
        (value): value is string => Boolean(value),
      );
    }),
  );
}

function materializeFaces(
  parsedFaces: Map<string, ParsedFace>,
  parsedFaceBounds: Map<string, ParsedFaceBound>,
  parsedEdgeLoops: Map<string, string[]>,
  parsedOrientedEdges: Map<string, ParsedOrientedEdge>,
  faceIdBySource: Map<string, string>,
  edgeIdBySource: Map<string, string>,
  edgeById: Map<string, CanonicalEdgeGeometry>,
  entityById: Map<string, StepEntity>,
): CanonicalFaceGeometry[] {
  return [...parsedFaces.values()]
    .sort((left, right) => compareStepEntityRefs(left.sourceEntityId, right.sourceEntityId))
    .map((face) => {
      const bounds = face.boundRefs.map((boundRef): CanonicalFaceBound => {
        const bound = parsedFaceBounds.get(boundRef);
        const loopRefs = bound?.loopRef ? parsedEdgeLoops.get(bound.loopRef) ?? [] : [];
        const orientedEdges = loopRefs.flatMap((loopRef): CanonicalOrientedEdgeReference[] => {
          const orientedEdge = parsedOrientedEdges.get(loopRef);
          const edgeId = orientedEdge?.edgeRef ? edgeIdBySource.get(orientedEdge.edgeRef) : null;
          return edgeId
            ? [{ edgeId, orientation: orientedEdge?.orientation ?? "unknown" }]
            : [];
        });

        return {
          kind: bound?.kind ?? "unknown",
          orientedEdges,
          edgeIds: uniquePreserveOrder(orientedEdges.map((orientedEdge) => orientedEdge.edgeId)),
        };
      });
      const edgeIds = uniquePreserveOrder(bounds.flatMap((bound) => bound.edgeIds));

      return {
        id: faceIdBySource.get(face.sourceEntityId)!,
        sourceEntityId: face.sourceEntityId,
        surfaceType: face.surfaceRef ? entityById.get(face.surfaceRef)?.type ?? null : null,
        orientation: face.orientation,
        bounds,
        edgeIds,
        vertexIds: collectVertexIdsFromEdges(edgeIds, edgeById),
      };
    });
}

function materializeShells(
  parsedShells: Map<string, ParsedShell>,
  shellIdBySource: Map<string, string>,
  faceIdBySource: Map<string, string>,
): CanonicalShellGeometry[] {
  return [...parsedShells.values()]
    .sort((left, right) => compareStepEntityRefs(left.sourceEntityId, right.sourceEntityId))
    .map((shell) => ({
      id: shellIdBySource.get(shell.sourceEntityId)!,
      sourceEntityId: shell.sourceEntityId,
      closure: shell.closure,
      faceIds: shell.faceRefs
        .map((faceRef) => faceIdBySource.get(faceRef) ?? null)
        .filter((faceId): faceId is string => Boolean(faceId)),
    }));
}

function collectVertexPositions(
  vertexIds: string[],
  vertexById: Map<string, CanonicalVertexGeometry>,
): Vector3[] {
  return vertexIds
    .map((vertexId) => vertexById.get(vertexId)?.position ?? null)
    .filter((position): position is Vector3 => Boolean(position));
}

function materializeBodies(
  parsedBodies: Map<string, ParsedBody>,
  bodyIdBySource: Map<string, string>,
  shellIdBySource: Map<string, string>,
  shellById: Map<string, CanonicalShellGeometry>,
  faceById: Map<string, CanonicalFaceGeometry>,
  edgeById: Map<string, CanonicalEdgeGeometry>,
  vertexById: Map<string, CanonicalVertexGeometry>,
): CanonicalBodyGeometry[] {
  return [...parsedBodies.values()]
    .sort((left, right) => compareStepEntityRefs(left.sourceEntityId, right.sourceEntityId))
    .map((body) => {
      const shellIds = body.shellRefs
        .map((shellRef) => shellIdBySource.get(shellRef) ?? null)
        .filter((shellId): shellId is string => Boolean(shellId));
      const faceIds = uniquePreserveOrder(shellIds.flatMap((shellId) => shellById.get(shellId)?.faceIds ?? []));
      const edgeIds = uniquePreserveOrder(faceIds.flatMap((faceId) => faceById.get(faceId)?.edgeIds ?? []));
      const vertexIds = collectVertexIdsFromEdges(edgeIds, edgeById);

      return {
        id: bodyIdBySource.get(body.sourceEntityId)!,
        sourceEntityId: body.sourceEntityId,
        kind: body.kind,
        shellIds,
        faceIds,
        edgeIds,
        vertexIds,
        boundingBox: buildBoundingBox(collectVertexPositions(vertexIds, vertexById)),
      };
    });
}

function buildOverallBoundingBox(
  bodies: CanonicalBodyGeometry[],
  vertices: CanonicalVertexGeometry[],
  vertexById: Map<string, CanonicalVertexGeometry>,
) {
  const bodyPoints = bodies.flatMap((body) => collectVertexPositions(body.vertexIds, vertexById));
  return buildBoundingBox(bodyPoints.length > 0 ? bodyPoints : vertices.map((vertex) => vertex.position));
}

function buildSummary(
  entities: StepEntity[],
  bodies: CanonicalBodyGeometry[],
  shells: CanonicalShellGeometry[],
  faces: CanonicalFaceGeometry[],
  edges: CanonicalEdgeGeometry[],
  vertices: CanonicalVertexGeometry[],
) {
  return {
    sourceEntityCount: entities.length,
    bodyCount: bodies.length,
    solidBodyCount: bodies.filter((body) => body.kind === "solid").length,
    surfaceBodyCount: bodies.filter((body) => body.kind === "surface").length,
    shellCount: shells.length,
    faceCount: faces.length,
    edgeCount: edges.length,
    vertexCount: vertices.length,
  };
}

function buildCanonicalGeometryMetadata(args: {
  headerSection: string;
  entities: StepEntity[];
  sourceName?: string | null;
  bodies: CanonicalBodyGeometry[];
  shells: CanonicalShellGeometry[];
  faces: CanonicalFaceGeometry[];
  edges: CanonicalEdgeGeometry[];
  vertices: CanonicalVertexGeometry[];
  vertexById: Map<string, CanonicalVertexGeometry>;
}): CanonicalPartGeometryMetadata {
  return {
    schemaVersion: CANONICAL_PART_GEOMETRY_SCHEMA_VERSION,
    sourceFormat: "step",
    sourceName: args.sourceName ?? null,
    source: parseHeaderMetadata(args.headerSection, args.entities),
    units: parseLengthUnit(args.entities),
    summary: buildSummary(args.entities, args.bodies, args.shells, args.faces, args.edges, args.vertices),
    boundingBox: buildOverallBoundingBox(args.bodies, args.vertices, args.vertexById),
    vertices: args.vertices,
    edges: args.edges,
    faces: args.faces,
    shells: args.shells,
    bodies: args.bodies,
  };
}

/**
 * Normalizes STEP content into deterministic `canonical-part-geometry.v1` metadata.
 * Throws when the STEP `DATA` section does not produce any parseable entities.
 */
export function normalizeStepToCanonicalGeometryMetadata(input: {
  stepContent: string;
  sourceName?: string | null;
}): CanonicalPartGeometryMetadata {
  const headerSection = extractSection(input.stepContent, "HEADER");
  const entities = parseStepEntities(extractSection(input.stepContent, "DATA"));
  if (entities.length === 0) {
    throw new Error("STEP normalization requires at least one parsed DATA entity.");
  }

  const topology = collectParsedTopology(entities);
  const entityById = new Map(entities.map((entity) => [entity.sourceEntityId, entity]));
  const edgeIdBySource = buildCanonicalIdMap(topology.parsedEdges.keys(), "edge");
  const faceIdBySource = buildCanonicalIdMap(topology.parsedFaces.keys(), "face");
  const shellIdBySource = buildCanonicalIdMap(topology.parsedShells.keys(), "shell");
  const bodyIdBySource = buildCanonicalIdMap(topology.parsedBodies.keys(), "body");
  const { vertices, vertexIdBySource, vertexById } = materializeVertices(
    topology.parsedVertices,
    topology.cartesianPoints,
  );
  const edges = materializeEdges(topology.parsedEdges, edgeIdBySource, vertexIdBySource, entityById);
  const edgeById = new Map(edges.map((edge) => [edge.id, edge]));
  const faces = materializeFaces(
    topology.parsedFaces,
    topology.parsedFaceBounds,
    topology.parsedEdgeLoops,
    topology.parsedOrientedEdges,
    faceIdBySource,
    edgeIdBySource,
    edgeById,
    entityById,
  );
  const faceById = new Map(faces.map((face) => [face.id, face]));
  const shells = materializeShells(topology.parsedShells, shellIdBySource, faceIdBySource);
  const shellById = new Map(shells.map((shell) => [shell.id, shell]));
  const bodies = materializeBodies(
    topology.parsedBodies,
    bodyIdBySource,
    shellIdBySource,
    shellById,
    faceById,
    edgeById,
    vertexById,
  );

  return buildCanonicalGeometryMetadata({
    headerSection,
    entities,
    sourceName: input.sourceName,
    bodies,
    shells,
    faces,
    edges,
    vertices,
    vertexById,
  });
}
