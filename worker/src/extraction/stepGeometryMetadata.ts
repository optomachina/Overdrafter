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

type FaceMaterializationContext = {
  parsedFaceBounds: Map<string, ParsedFaceBound>;
  parsedEdgeLoops: Map<string, string[]>;
  parsedOrientedEdges: Map<string, ParsedOrientedEdge>;
  edgeIdBySource: Map<string, string>;
  edgeById: Map<string, CanonicalEdgeGeometry>;
  entityById: Map<string, StepEntity>;
};

type StepQuoteParseResult = {
  current: string;
  inString: boolean;
  advance: number;
};

type TopologyEntityHandler = (
  entity: StepEntity,
  args: string[],
  topology: ParsedTopology,
) => void;

function splitTopLevel(value: string, delimiter = ","): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let inString = false;
  let index = 0;

  while (index < value.length) {
    const character = value[index];
    if (character === undefined) {
      index += 1;
      continue;
    }

    if (character === "'") {
      const quote = consumeStepQuote(value, index, current, inString);
      current = quote.current;
      inString = quote.inString;
      index += quote.advance;
      continue;
    }

    if (!inString && character === delimiter && depth === 0) {
      parts.push(current.trim());
      current = "";
      index += 1;
      continue;
    }

    depth = inString ? depth : updateStepDepth(depth, character);
    current += character;
    index += 1;
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
    return trimmed.slice(1, -1).replaceAll("''", "'");
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

  return /#\d+/.exec(token.trim())?.[0] ?? null;
}

function parseReferenceList(token: string | undefined): string[] {
  if (!token) {
    return [];
  }

  return token.match(/#\d+/g) ?? [];
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
  const firstPoint = points[0];
  if (!firstPoint) {
    return null;
  }

  const min = { ...firstPoint };
  const max = { ...firstPoint };

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

function consumeStepQuote(
  source: string,
  index: number,
  current: string,
  inString: boolean,
): StepQuoteParseResult {
  const next = source[index + 1];
  let nextCurrent = `${current}'`;

  if (inString && next === "'") {
    nextCurrent += next;
    return { current: nextCurrent, inString, advance: 2 };
  }

  return { current: nextCurrent, inString: !inString, advance: 1 };
}

function findStepTokenOutsideQuotes(source: string, token: string, startIndex = 0) {
  let inString = false;
  let index = startIndex;

  while (index < source.length) {
    const character = source[index];
    if (character === undefined) {
      index += 1;
      continue;
    }

    if (character === "'") {
      const quote = consumeStepQuote(source, index, "", inString);
      inString = quote.inString;
      index += quote.advance;
      continue;
    }

    if (!inString && source.startsWith(token, index)) {
      return index;
    }

    index += 1;
  }

  return -1;
}

function updateStepDepth(depth: number, character: string) {
  if (character === "(") {
    return depth + 1;
  }

  if (character === ")") {
    return Math.max(0, depth - 1);
  }

  return depth;
}

function extractSection(stepContent: string, sectionName: "HEADER" | "DATA") {
  const upperContent = stepContent.toUpperCase();
  const sectionStart = findStepTokenOutsideQuotes(upperContent, `${sectionName};`);
  if (sectionStart < 0) {
    return "";
  }

  const contentStart = sectionStart + sectionName.length + 1;
  const sectionEnd = findStepTokenOutsideQuotes(upperContent, "ENDSEC;", contentStart);
  if (sectionEnd >= 0) {
    return stepContent.slice(contentStart, sectionEnd);
  }
  return "";
}

function tokenizeStepStatements(dataSection: string): string[] {
  const statements: string[] = [];
  let current = "";
  let collecting = false;
  let depth = 0;
  let inString = false;
  let index = 0;

  while (index < dataSection.length) {
    if (!collecting) {
      const character = dataSection[index];
      if (character === "#") {
        collecting = true;
        current = character;
        depth = 0;
        inString = false;
      }
      index += 1;
      continue;
    }

    const character = dataSection[index];
    if (character === undefined) {
      index += 1;
      continue;
    }

    if (character === "'") {
      const quote = consumeStepQuote(dataSection, index, current, inString);
      current = quote.current;
      inString = quote.inString;
      index += quote.advance;
      continue;
    }

    current += character;

    if (inString) {
      index += 1;
      continue;
    }

    depth = updateStepDepth(depth, character);
    if (character === ";" && depth === 0) {
      statements.push(current.slice(0, -1).trim());
      current = "";
      collecting = false;
    }

    index += 1;
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

function handleCartesianPoint(entity: StepEntity, args: string[], topology: ParsedTopology) {
  const numbers = parseTupleNumbers(args[1]);
  const [x, y, z] = numbers;
  if (x === undefined || y === undefined || z === undefined) {
    return;
  }

  topology.cartesianPoints.set(entity.sourceEntityId, { x, y, z });
}

function handleVertexPoint(entity: StepEntity, args: string[], topology: ParsedTopology) {
  topology.parsedVertices.set(entity.sourceEntityId, {
    sourceEntityId: entity.sourceEntityId,
    cartesianPointRef: parseReference(args[1]),
  });
}

function handleEdgeCurve(entity: StepEntity, args: string[], topology: ParsedTopology) {
  topology.parsedEdges.set(entity.sourceEntityId, {
    sourceEntityId: entity.sourceEntityId,
    startVertexRef: parseReference(args[1]),
    endVertexRef: parseReference(args[2]),
    curveRef: parseReference(args[3]),
  });
}

function handleOrientedEdge(entity: StepEntity, args: string[], topology: ParsedTopology) {
  topology.parsedOrientedEdges.set(entity.sourceEntityId, {
    edgeRef: parseReference(args[3]),
    orientation: parseOrientedEdgeOrientation(args[4]),
  });
}

function handleEdgeLoop(entity: StepEntity, args: string[], topology: ParsedTopology) {
  topology.parsedEdgeLoops.set(entity.sourceEntityId, parseReferenceList(args[1]));
}

function handleFaceBound(entity: StepEntity, args: string[], topology: ParsedTopology) {
  topology.parsedFaceBounds.set(entity.sourceEntityId, {
    kind: entity.type === "FACE_OUTER_BOUND" ? "outer" : "unknown",
    loopRef: parseReference(args[1]),
  });
}

function handleAdvancedFace(entity: StepEntity, args: string[], topology: ParsedTopology) {
  topology.parsedFaces.set(entity.sourceEntityId, {
    sourceEntityId: entity.sourceEntityId,
    boundRefs: parseReferenceList(args[1]),
    surfaceRef: parseReference(args[2]),
    orientation: parseBooleanToken(args[3]),
  });
}

function handleShell(entity: StepEntity, args: string[], topology: ParsedTopology) {
  topology.parsedShells.set(entity.sourceEntityId, {
    sourceEntityId: entity.sourceEntityId,
    closure: entity.type === "CLOSED_SHELL" ? "closed" : "open",
    faceRefs: parseReferenceList(args[1]),
  });
}

function setParsedBody(
  entity: StepEntity,
  args: string[],
  topology: ParsedTopology,
  kind: ParsedBody["kind"],
) {
  topology.parsedBodies.set(entity.sourceEntityId, {
    sourceEntityId: entity.sourceEntityId,
    kind,
    shellRefs: parseReferenceList(args[1]),
  });
}

function handleSolidBody(entity: StepEntity, args: string[], topology: ParsedTopology) {
  setParsedBody(entity, args, topology, "solid");
}

function handleSurfaceBody(entity: StepEntity, args: string[], topology: ParsedTopology) {
  setParsedBody(entity, args, topology, "surface");
}

const TOPOLOGY_ENTITY_HANDLERS: Partial<Record<StepEntity["type"], TopologyEntityHandler>> = {
  CARTESIAN_POINT: handleCartesianPoint,
  VERTEX_POINT: handleVertexPoint,
  EDGE_CURVE: handleEdgeCurve,
  ORIENTED_EDGE: handleOrientedEdge,
  EDGE_LOOP: handleEdgeLoop,
  FACE_BOUND: handleFaceBound,
  FACE_OUTER_BOUND: handleFaceBound,
  ADVANCED_FACE: handleAdvancedFace,
  CLOSED_SHELL: handleShell,
  OPEN_SHELL: handleShell,
  MANIFOLD_SOLID_BREP: handleSolidBody,
  FACETED_BREP: handleSolidBody,
  SHELL_BASED_SURFACE_MODEL: handleSurfaceBody,
};

function captureTopologyEntity(entity: StepEntity, topology: ParsedTopology) {
  const handler = TOPOLOGY_ENTITY_HANDLERS[entity.type];
  if (!handler) {
    return;
  }

  handler(entity, splitTopLevel(entity.args ?? ""), topology);
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
  const fileNameMatch = /FILE_NAME\(([\s\S]*?)\)\s*;/i.exec(headerSection);
  const fileNameArgs = fileNameMatch ? splitTopLevel(fileNameMatch[1]) : [];
  const fileSchemaMatch = /FILE_SCHEMA\(([\s\S]*?)\)\s*;/i.exec(headerSection);
  const fileDescriptionMatch = /FILE_DESCRIPTION\(([\s\S]*?)\)\s*;/i.exec(headerSection);
  const [fileDescriptionArgs] = fileDescriptionMatch ? splitTopLevel(fileDescriptionMatch[1]) : [];

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
    description: fileDescriptionArgs ? parseStringList(fileDescriptionArgs) : [],
    productNames,
  };
}

function parseSiLengthUnit(entity: StepEntity) {
  const rawUpper = entity.rawValue.toUpperCase();
  if (!rawUpper.includes("LENGTH_UNIT") || !rawUpper.includes("SI_UNIT")) {
    return null;
  }

  const siMatch = /SI_UNIT\((\.[A-Z]+\.)?\s*,\s*(\.[A-Z]+\.)\)/i.exec(entity.rawValue);
  if (!siMatch) {
    return null;
  }

  const prefix = (siMatch[1] ?? "").toUpperCase();
  const base = siMatch[2].toUpperCase();
  if (base !== ".METRE.") {
    return null;
  }

  if (prefix === ".MILLI.") {
    return { length: "millimeter" as const, raw: "SI_UNIT(.MILLI.,.METRE.)" };
  }

  if (prefix === ".CENTI.") {
    return { length: "centimeter" as const, raw: "SI_UNIT(.CENTI.,.METRE.)" };
  }

  return { length: "meter" as const, raw: `SI_UNIT(${prefix || "$"},.METRE.)` };
}

function parseConversionLengthUnit(entity: StepEntity) {
  const rawUpper = entity.rawValue.toUpperCase();
  if (!rawUpper.includes("LENGTH_UNIT")) {
    return null;
  }

  const conversionMatch = /CONVERSION_BASED_UNIT\(\s*'([^']+)'/i.exec(entity.rawValue);
  if (!conversionMatch) {
    return null;
  }

  const normalized = conversionMatch[1].trim().toLowerCase();
  if (normalized === "inch" || normalized === "inches") {
    return { length: "inch" as const, raw: conversionMatch[0] };
  }

  if (normalized === "foot" || normalized === "feet") {
    return { length: "foot" as const, raw: conversionMatch[0] };
  }

  return { length: "unknown" as const, raw: conversionMatch[0] };
}

function parseLengthUnit(entities: StepEntity[]) {
  let fallbackRaw: string | null = null;

  for (const entity of entities) {
    const siUnit = parseSiLengthUnit(entity);
    if (siUnit) {
      return siUnit;
    }

    const conversionUnit = parseConversionLengthUnit(entity);
    if (!conversionUnit) {
      continue;
    }

    if (conversionUnit.length !== "unknown") {
      return conversionUnit;
    }

    fallbackRaw = conversionUnit.raw;
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

      const id = makeCanonicalId("vertex", result.length);
      result.push({
        id,
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
  faceIdBySource: Map<string, string>,
  context: FaceMaterializationContext,
): CanonicalFaceGeometry[] {
  return [...parsedFaces.values()]
    .sort((left, right) => compareStepEntityRefs(left.sourceEntityId, right.sourceEntityId))
    .map((face) => {
      const bounds = face.boundRefs.map((boundRef): CanonicalFaceBound => {
        const bound = context.parsedFaceBounds.get(boundRef);
        const loopRefs = bound?.loopRef ? context.parsedEdgeLoops.get(bound.loopRef) ?? [] : [];
        const orientedEdges = loopRefs.flatMap((loopRef): CanonicalOrientedEdgeReference[] => {
          const orientedEdge = context.parsedOrientedEdges.get(loopRef);
          const edgeId = orientedEdge?.edgeRef ? context.edgeIdBySource.get(orientedEdge.edgeRef) : null;
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
        surfaceType: face.surfaceRef ? context.entityById.get(face.surfaceRef)?.type ?? null : null,
        orientation: face.orientation,
        bounds,
        edgeIds,
        vertexIds: collectVertexIdsFromEdges(edgeIds, context.edgeById),
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
  return buildBoundingBox([...bodyPoints, ...vertices.map((vertex) => vertex.position)]);
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
    faceIdBySource,
    {
      parsedFaceBounds: topology.parsedFaceBounds,
      parsedEdgeLoops: topology.parsedEdgeLoops,
      parsedOrientedEdges: topology.parsedOrientedEdges,
      edgeIdBySource,
      edgeById,
      entityById,
    },
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
