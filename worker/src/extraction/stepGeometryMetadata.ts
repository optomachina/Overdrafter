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

function parseStepEntities(dataSection: string): StepEntity[] {
  const entities: StepEntity[] = [];
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

    if (character !== ";" || depth !== 0) {
      continue;
    }

    const statement = current.slice(0, -1).trim();
    current = "";
    collecting = false;

    const equalsIndex = statement.indexOf("=");
    if (!statement.startsWith("#") || equalsIndex <= 1) {
      continue;
    }

    const sourceEntityNumericId = Number.parseInt(
      statement.slice(1, equalsIndex).trim(),
      10,
    );
    if (!Number.isFinite(sourceEntityNumericId)) {
      continue;
    }

    const sourceEntityId = `#${sourceEntityNumericId}`;
    const rawValue = statement.slice(equalsIndex + 1).trim();

    if (rawValue.startsWith("(")) {
      entities.push({
        sourceEntityId,
        sourceEntityNumericId,
        type: "COMPLEX_ENTITY",
        args: null,
        rawValue,
      });
      continue;
    }

    const callMatch = rawValue.match(/^([A-Z0-9_]+)\s*\(([\s\S]*)\)$/);
    if (!callMatch) {
      entities.push({
        sourceEntityId,
        sourceEntityNumericId,
        type: "UNKNOWN",
        args: null,
        rawValue,
      });
      continue;
    }

    entities.push({
      sourceEntityId,
      sourceEntityNumericId,
      type: callMatch[1]!,
      args: callMatch[2]!,
      rawValue,
    });
  }

  return entities.sort((left, right) => left.sourceEntityNumericId - right.sourceEntityNumericId);
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
  for (const entity of entities) {
    const rawUpper = entity.rawValue.toUpperCase();

    if (rawUpper.includes("LENGTH_UNIT") && rawUpper.includes("SI_UNIT")) {
      const siMatch = entity.rawValue.match(/SI_UNIT\((\.[A-Z]+\.)?\s*,\s*(\.[A-Z]+\.)\)/i);
      if (!siMatch) {
        continue;
      }

      const prefix = (siMatch[1] ?? "").toUpperCase();
      const base = siMatch[2]!.toUpperCase();

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

    const conversionMatch = entity.rawValue.match(/CONVERSION_BASED_UNIT\(\s*'([^']+)'/i);
    if (!conversionMatch) {
      continue;
    }

    const normalized = conversionMatch[1]!.trim().toLowerCase();
    if (normalized === "inch" || normalized === "inches") {
      return { length: "inch" as const, raw: conversionMatch[0] };
    }

    if (normalized === "foot" || normalized === "feet") {
      return { length: "foot" as const, raw: conversionMatch[0] };
    }

    return { length: "unknown" as const, raw: conversionMatch[0] };
  }

  return { length: "unknown" as const, raw: null };
}

export function normalizeStepToCanonicalGeometryMetadata(input: {
  stepContent: string;
  sourceName?: string | null;
}): CanonicalPartGeometryMetadata {
  const headerSection = extractSection(input.stepContent, "HEADER");
  const dataSection = extractSection(input.stepContent, "DATA");
  const entities = parseStepEntities(dataSection);

  if (entities.length === 0) {
    throw new Error("STEP normalization requires at least one parsed DATA entity.");
  }

  const entityById = new Map(entities.map((entity) => [entity.sourceEntityId, entity]));
  const cartesianPoints = new Map<string, Vector3>();
  const parsedVertices = new Map<string, ParsedVertex>();
  const parsedEdges = new Map<string, ParsedEdge>();
  const parsedOrientedEdges = new Map<string, ParsedOrientedEdge>();
  const parsedEdgeLoops = new Map<string, string[]>();
  const parsedFaceBounds = new Map<string, ParsedFaceBound>();
  const parsedFaces = new Map<string, ParsedFace>();
  const parsedShells = new Map<string, ParsedShell>();
  const parsedBodies = new Map<string, ParsedBody>();

  for (const entity of entities) {
    const args = splitTopLevel(entity.args ?? "");

    switch (entity.type) {
      case "CARTESIAN_POINT": {
        const numbers = parseTupleNumbers(args[1]);
        if (numbers.length >= 3) {
          cartesianPoints.set(entity.sourceEntityId, {
            x: numbers[0]!,
            y: numbers[1]!,
            z: numbers[2]!,
          });
        }
        break;
      }
      case "VERTEX_POINT": {
        parsedVertices.set(entity.sourceEntityId, {
          sourceEntityId: entity.sourceEntityId,
          cartesianPointRef: parseReference(args[1]),
        });
        break;
      }
      case "EDGE_CURVE": {
        parsedEdges.set(entity.sourceEntityId, {
          sourceEntityId: entity.sourceEntityId,
          startVertexRef: parseReference(args[1]),
          endVertexRef: parseReference(args[2]),
          curveRef: parseReference(args[3]),
        });
        break;
      }
      case "ORIENTED_EDGE": {
        parsedOrientedEdges.set(entity.sourceEntityId, {
          edgeRef: parseReference(args[3]),
          orientation:
            parseBooleanToken(args[4]) === true
              ? "forward"
              : parseBooleanToken(args[4]) === false
                ? "reversed"
                : "unknown",
        });
        break;
      }
      case "EDGE_LOOP": {
        parsedEdgeLoops.set(entity.sourceEntityId, parseReferenceList(args[1]));
        break;
      }
      case "FACE_BOUND":
      case "FACE_OUTER_BOUND": {
        parsedFaceBounds.set(entity.sourceEntityId, {
          kind: entity.type === "FACE_OUTER_BOUND" ? "outer" : "inner",
          loopRef: parseReference(args[1]),
        });
        break;
      }
      case "ADVANCED_FACE": {
        parsedFaces.set(entity.sourceEntityId, {
          sourceEntityId: entity.sourceEntityId,
          boundRefs: parseReferenceList(args[1]),
          surfaceRef: parseReference(args[2]),
          orientation: parseBooleanToken(args[3]),
        });
        break;
      }
      case "CLOSED_SHELL":
      case "OPEN_SHELL": {
        parsedShells.set(entity.sourceEntityId, {
          sourceEntityId: entity.sourceEntityId,
          closure: entity.type === "CLOSED_SHELL" ? "closed" : "open",
          faceRefs: parseReferenceList(args[1]),
        });
        break;
      }
      case "MANIFOLD_SOLID_BREP":
      case "FACETED_BREP": {
        parsedBodies.set(entity.sourceEntityId, {
          sourceEntityId: entity.sourceEntityId,
          kind: "solid",
          shellRefs: parseReferenceList(args[1]),
        });
        break;
      }
      case "SHELL_BASED_SURFACE_MODEL": {
        parsedBodies.set(entity.sourceEntityId, {
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

  if (parsedBodies.size === 0 && parsedShells.size > 0) {
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

  const vertexIdBySource = new Map(
    [...parsedVertices.keys()]
      .sort(compareStepEntityRefs)
      .map((sourceEntityId, index) => [sourceEntityId, makeCanonicalId("vertex", index)]),
  );
  const edgeIdBySource = new Map(
    [...parsedEdges.keys()]
      .sort(compareStepEntityRefs)
      .map((sourceEntityId, index) => [sourceEntityId, makeCanonicalId("edge", index)]),
  );
  const faceIdBySource = new Map(
    [...parsedFaces.keys()]
      .sort(compareStepEntityRefs)
      .map((sourceEntityId, index) => [sourceEntityId, makeCanonicalId("face", index)]),
  );
  const shellIdBySource = new Map(
    [...parsedShells.keys()]
      .sort(compareStepEntityRefs)
      .map((sourceEntityId, index) => [sourceEntityId, makeCanonicalId("shell", index)]),
  );
  const bodyIdBySource = new Map(
    [...parsedBodies.keys()]
      .sort(compareStepEntityRefs)
      .map((sourceEntityId, index) => [sourceEntityId, makeCanonicalId("body", index)]),
  );

  const vertices = [...parsedVertices.values()]
    .sort((left, right) => compareStepEntityRefs(left.sourceEntityId, right.sourceEntityId))
    .flatMap((vertex): CanonicalVertexGeometry[] => {
      const point = vertex.cartesianPointRef ? cartesianPoints.get(vertex.cartesianPointRef) : null;
      const id = vertexIdBySource.get(vertex.sourceEntityId);
      if (!point || !id) {
        return [];
      }

      return [
        {
          id,
          sourceEntityId: vertex.sourceEntityId,
          position: point,
        },
      ];
    });
  const vertexById = new Map(vertices.map((vertex) => [vertex.id, vertex]));

  const edges = [...parsedEdges.values()]
    .sort((left, right) => compareStepEntityRefs(left.sourceEntityId, right.sourceEntityId))
    .map(
      (edge): CanonicalEdgeGeometry => ({
        id: edgeIdBySource.get(edge.sourceEntityId)!,
        sourceEntityId: edge.sourceEntityId,
        startVertexId: edge.startVertexRef ? vertexIdBySource.get(edge.startVertexRef) ?? null : null,
        endVertexId: edge.endVertexRef ? vertexIdBySource.get(edge.endVertexRef) ?? null : null,
        curveType: edge.curveRef ? entityById.get(edge.curveRef)?.type ?? null : null,
      }),
    );
  const edgeById = new Map(edges.map((edge) => [edge.id, edge]));

  const faces = [...parsedFaces.values()]
    .sort((left, right) => compareStepEntityRefs(left.sourceEntityId, right.sourceEntityId))
    .map((face): CanonicalFaceGeometry => {
      const bounds = face.boundRefs.map((boundRef): CanonicalFaceBound => {
        const bound = parsedFaceBounds.get(boundRef);
        const loopRefs = bound?.loopRef ? parsedEdgeLoops.get(bound.loopRef) ?? [] : [];
        const orientedEdges = loopRefs.flatMap((loopRef): CanonicalOrientedEdgeReference[] => {
          const orientedEdge = parsedOrientedEdges.get(loopRef);
          const edgeId = orientedEdge?.edgeRef ? edgeIdBySource.get(orientedEdge.edgeRef) : null;
          if (!edgeId) {
            return [];
          }

          return [
            {
              edgeId,
              orientation: orientedEdge?.orientation ?? "unknown",
            },
          ];
        });

        return {
          kind: bound?.kind ?? "unknown",
          orientedEdges,
          edgeIds: uniquePreserveOrder(orientedEdges.map((orientedEdge) => orientedEdge.edgeId)),
        };
      });

      const edgeIds = uniquePreserveOrder(bounds.flatMap((bound) => bound.edgeIds));
      const vertexIds = uniquePreserveOrder(
        edgeIds.flatMap((edgeId) => {
          const edge = edgeById.get(edgeId);
          return [edge?.startVertexId ?? null, edge?.endVertexId ?? null].filter(
            (value): value is string => Boolean(value),
          );
        }),
      );

      return {
        id: faceIdBySource.get(face.sourceEntityId)!,
        sourceEntityId: face.sourceEntityId,
        surfaceType: face.surfaceRef ? entityById.get(face.surfaceRef)?.type ?? null : null,
        orientation: face.orientation,
        bounds,
        edgeIds,
        vertexIds,
      };
    });
  const faceById = new Map(faces.map((face) => [face.id, face]));

  const shells = [...parsedShells.values()]
    .sort((left, right) => compareStepEntityRefs(left.sourceEntityId, right.sourceEntityId))
    .map(
      (shell): CanonicalShellGeometry => ({
        id: shellIdBySource.get(shell.sourceEntityId)!,
        sourceEntityId: shell.sourceEntityId,
        closure: shell.closure,
        faceIds: shell.faceRefs
          .map((faceRef) => faceIdBySource.get(faceRef) ?? null)
          .filter((faceId): faceId is string => Boolean(faceId)),
      }),
    );
  const shellById = new Map(shells.map((shell) => [shell.id, shell]));

  const bodies = [...parsedBodies.values()]
    .sort((left, right) => compareStepEntityRefs(left.sourceEntityId, right.sourceEntityId))
    .map((body): CanonicalBodyGeometry => {
      const shellIds = body.shellRefs
        .map((shellRef) => shellIdBySource.get(shellRef) ?? null)
        .filter((shellId): shellId is string => Boolean(shellId));
      const faceIds = uniquePreserveOrder(
        shellIds.flatMap((shellId) => shellById.get(shellId)?.faceIds ?? []),
      );
      const edgeIds = uniquePreserveOrder(faceIds.flatMap((faceId) => faceById.get(faceId)?.edgeIds ?? []));
      const vertexIds = uniquePreserveOrder(
        edgeIds.flatMap((edgeId) => {
          const edge = edgeById.get(edgeId);
          return [edge?.startVertexId ?? null, edge?.endVertexId ?? null].filter(
            (value): value is string => Boolean(value),
          );
        }),
      );
      const points = vertexIds
        .map((vertexId) => vertexById.get(vertexId)?.position ?? null)
        .filter((position): position is Vector3 => Boolean(position));

      return {
        id: bodyIdBySource.get(body.sourceEntityId)!,
        sourceEntityId: body.sourceEntityId,
        kind: body.kind,
        shellIds,
        faceIds,
        edgeIds,
        vertexIds,
        boundingBox: buildBoundingBox(points),
      };
    });

  const overallBoundingBox = buildBoundingBox(
    bodies.flatMap((body) =>
      body.vertexIds
        .map((vertexId) => vertexById.get(vertexId)?.position ?? null)
        .filter((position): position is Vector3 => Boolean(position)),
    ).length > 0
      ? bodies.flatMap((body) =>
          body.vertexIds
            .map((vertexId) => vertexById.get(vertexId)?.position ?? null)
            .filter((position): position is Vector3 => Boolean(position)),
        )
      : vertices.map((vertex) => vertex.position),
  );

  const source = parseHeaderMetadata(headerSection, entities);
  const units = parseLengthUnit(entities);

  return {
    schemaVersion: CANONICAL_PART_GEOMETRY_SCHEMA_VERSION,
    sourceFormat: "step",
    sourceName: input.sourceName ?? null,
    source,
    units,
    summary: {
      sourceEntityCount: entities.length,
      bodyCount: bodies.length,
      solidBodyCount: bodies.filter((body) => body.kind === "solid").length,
      surfaceBodyCount: bodies.filter((body) => body.kind === "surface").length,
      shellCount: shells.length,
      faceCount: faces.length,
      edgeCount: edges.length,
      vertexCount: vertices.length,
    },
    boundingBox: overallBoundingBox,
    vertices,
    edges,
    faces,
    shells,
    bodies,
  };
}
