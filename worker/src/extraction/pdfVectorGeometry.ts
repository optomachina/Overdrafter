import { svgNumbers as numbers, svgPathTokens, svgTags } from "./pdfParsing.js";
import type { TitleBlockBorder } from "./titleBlockCells.js";

export type GeometryBounds = { x0: number; y0: number; x1: number; y1: number };
export type GeometryIssue = { cause: string; bounds: GeometryBounds | null };
export type PageVectorGeometry = {
  /** Positive proof of a complete scan in the word boxes' coordinate frame. */
  complete: boolean;
  issues: GeometryIssue[];
  width?: number;
  height?: number;
  rules?: GeometryBounds[];
};
type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const COORDINATE_COUNTS: Readonly<Record<string, number>> = { M: 2, L: 2, C: 6, Q: 4 };
const attribute = (tag: string, name: string) => new RegExp(String.raw`(?:^|\s)${name}="([^"]*)"`).exec(tag)?.[1];
function transformOf(tag: string): Matrix | null {
  const value = attribute(tag, "transform");
  if (!value) return IDENTITY;
  if (!/^matrix\([\d.eE+,\s-]+\)$/.test(value)) return null;
  const matrix = numbers(value);
  return matrix.length === 6 && matrix.every(Number.isFinite) ? matrix as Matrix : null;
}
function compose(left: Matrix | null, right: Matrix | null): Matrix | null {
  if (!left || !right) return null;
  const [a, b, c, d, e, f] = left, [g, h, i, j, k, l] = right;
  return [a*g+c*h, b*g+d*h, a*i+c*j, b*i+d*j, a*k+c*l+e, b*k+d*l+f];
}
function point(x: number, y: number, m: Matrix): [number, number] {
  return [m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5]];
}
function hull(points: readonly [number, number][]): GeometryBounds | null {
  if (!points.length) return null;
  const bounds = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const [x, y] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    bounds.x0 = Math.min(bounds.x0, x); bounds.x1 = Math.max(bounds.x1, x);
    bounds.y0 = Math.min(bounds.y0, y); bounds.y1 = Math.max(bounds.y1, y);
  }
  return bounds;
}
function rectangle(bounds: GeometryBounds, m: Matrix): GeometryBounds | null {
  return hull([[bounds.x0, bounds.y0], [bounds.x0, bounds.y1], [bounds.x1, bounds.y0], [bounds.x1, bounds.y1]]
    .map(([x, y]) => point(x!, y!, m)));
}
type PathSegment = { bounds: GeometryBounds; rule?: GeometryBounds };
type Subpath = { points: [number, number][]; segments: PathSegment[] };
/** Cairo uses absolute M/L/C/Q/Z paths. Keep subpaths and curve control hulls separate. */
function pathGeometry(data: string, matrix: Matrix | null) {
  if (!matrix || data.length > 1_000_000) return null;
  const tokens = svgPathTokens(data);
  if (!tokens) return null;
  const subpaths: Subpath[] = [];
  let current: [number, number] | undefined, start: [number, number] | undefined;
  let subpath: Subpath | undefined;
  const edge = (end: [number, number]) => {
    if (current && subpath) subpath.segments.push({ bounds: hull([current, end])!,
      rule: { x0: current[0], y0: current[1], x1: end[0], y1: end[1] } });
    current = end;
  };
  for (let i = 0; i < tokens.length;) {
    const command = tokens[i++]!;
    if (command === "Z") {
      if (!start || !current) return null;
      edge(start);
      continue;
    }
    const count = COORDINATE_COUNTS[command] ?? 0;
    if (!count || i + count > tokens.length) return null;
    const coords = tokens.slice(i, i + count).map(Number);
    if (!coords.every(Number.isFinite)) return null;
    i += count;
    const part: [number, number][] = [];
    for (let j = 0; j < count; j += 2) part.push(point(coords[j]!, coords[j+1]!, matrix));
    if (!hull(part)) return null;
    const end = part.at(-1)!;
    if (command === "M") {
      current = end; start = end;
      subpath = { points: [end], segments: [] }; subpaths.push(subpath);
    } else {
      if (!current || !subpath) return null;
      subpath.points.push(...part);
      if (command === "L") edge(end);
      else { subpath.segments.push({ bounds: hull([current, ...part])! }); current = end; }
    }
  }
  return subpaths;
}
/** Unknown paint stays unclassified; a known non-white colour need not be black. */
function strokeColour(value: string): "white" | "colour" | "unknown" {
  const v = value.trim().toLowerCase();
  if (v === "white") return "white";
  if (/^(?:black|red|green|blue|gray|grey|yellow|cyan|magenta)$/.test(v)) return "colour";
  if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/.test(v)) return /^#f{3}(?:f{3})?$/.test(v) ? "white" : "colour";
  if (!v.startsWith("rgb(") || !v.endsWith(")")) return "unknown";
  const rgb = v.slice(4, -1).split(",").map((channel) => channel.trim());
  if (rgb.length !== 3 || !rgb.every((channel) => /^\d+(?:\.\d+)?%?$/.test(channel))) return "unknown";
  const channels = rgb.map((channel) => Number.parseFloat(channel) / (channel.endsWith("%") ? 100 : 255));
  if (channels.some((channel) => channel < 0 || channel > 1)) return "unknown";
  return channels.every((channel) => channel === 1) ? "white" : "colour";
}
function opacity(tag: string, name: string): number {
  const value = Number(attribute(tag, name) ?? 1);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : Number.NaN;
}
function black(value: string | undefined): boolean {
  if (value === "black" || value === "#000000" || value === "#000") return true;
  const rgb = /^rgb\(([^)]+)\)$/.exec(value ?? "");
  return Boolean(rgb && numbers(rgb[1]!).length === 3 && numbers(rgb[1]!).every((n) => n === 0));
}
/** Merge only touching collinear segments. Never bridge a visible gap. */
export function mergeHorizontalBorders(borders: readonly TitleBlockBorder[]): TitleBlockBorder[] {
  const sorted = borders.map((border) => ({ ...border })).sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const result: TitleBlockBorder[] = [];
  for (const border of sorted) {
    const last = result.at(-1);
    if (last && Math.abs(last.y - border.y) < 0.01 && border.x0 <= last.x1 + 0.01) last.x1 = Math.max(last.x1, border.x1);
    else result.push(border);
  }
  return result;
}

/**
 * Cairo can inline a Form XObject into ordinary SVG paths, losing its provenance. Scan PDF names
 * before trusting that SVG. Compressed object dictionaries and encrypted sources are deliberately
 * unproven here; this bounded scan does not pretend to be a second PDF interpreter.
 */
export function pdfSourceGeometryIssues(bytes: Buffer): GeometryIssue[] {
  if (bytes.length > 32 * 1024 * 1024) return [{ cause: "pdf_source_limit", bounds: null }];
  const names = new Set((bytes.toString("latin1").match(/\/[^\s()[\]{}<>/%]+/g) ?? [])
    .map((name) => name.replace(/#([0-9a-f]{2})/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))));
  const issues: GeometryIssue[] = [];
  if (names.has("/Form")) issues.push({ cause: "form_xobject", bounds: null });
  if (names.has("/ObjStm")) issues.push({ cause: "unclassified_pdf_object_stream", bounds: null });
  if (names.has("/Encrypt")) issues.push({ cause: "encrypted_pdf_geometry", bounds: null });
  return issues;
}

/** I7: unsupported paint is monotonic negative evidence, never a reason to discard earlier rules. */
export function readSvgGeometry(svg: string, pageSize: { width: number; height: number }): { borders: TitleBlockBorder[]; vectorGeometry: PageVectorGeometry } {
  const issues: GeometryIssue[] = [], rules: GeometryBounds[] = [];
  const geometry: PageVectorGeometry = { complete: true, issues, rules, ...pageSize };
  const issue = (cause: string, bounds: GeometryBounds | null = null) => {
    if (issues.length < 2_000) issues.push({ cause, bounds });
    else geometry.complete = false;
  };
  let root = "";
  for (const { tag } of svgTags(svg)) {
    if (/^<svg\b/.test(tag)) { root = tag; break; }
  }
  const viewBox = numbers(attribute(root, "viewBox") ?? "");
  if (/\s(?:transform|style|clip-path|mask|filter)=/.test(root)) issue("unclassified_page_transform");
  if (!svg.trimEnd().endsWith("</svg>") || !root) { geometry.complete = false; issue("incomplete_svg"); }
  if (viewBox.length !== 4 || viewBox[0] !== 0 || viewBox[1] !== 0 ||
    !Number.isFinite(pageSize.width) || !Number.isFinite(pageSize.height) ||
    Math.abs(viewBox[2]! - pageSize.width) > 0.01 || Math.abs(viewBox[3]! - pageSize.height) > 0.01) {
    geometry.complete = false; issue("coordinate_frame_mismatch");
  }
  const definitions = new Map<string, string>();
  // Clip definitions describe affected area, not only the boundary's stroked edges.
  // Consume tags once so missing delimiters cannot restart a whole-suffix scan.
  const clips = new Map<string, string>();
  let clipStart: { id: string; start: number } | undefined;
  for (const { tag, start, end } of svgTags(svg)) {
    if (/^<(?:image|symbol|g|clipPath)\b/.test(tag)) {
      // The old greedy opening-tag pattern selected the last id, including a prefixed id.
      let id: string | undefined;
      for (const match of tag.matchAll(/\bid="([^"]+)"/g)) id = match[1];
      if (id !== undefined) {
        definitions.set(id, tag);
        if (tag.startsWith("<clipPath") && !clipStart) clipStart = { id, start };
      }
    }
    if (tag === "</clipPath>" && clipStart) {
      clips.set(clipStart.id, svg.slice(clipStart.start, end));
      clipStart = undefined;
    }
  }
  const clipCache = new Map<string, GeometryBounds | null>();
  const localClipBounds = (id: string): GeometryBounds | null => {
    const definition = clips.get(id);
    if (!definition) return null;
    const opening = definition.slice(0, definition.indexOf(">")+1);
    if ((attribute(opening, "clipPathUnits") ?? "userSpaceOnUse") !== "userSpaceOnUse" ||
      /\s(?:style|clip-path|mask|filter)=/.test(opening)) return null;
    const clipMatrix = transformOf(opening);
    const points: [number, number][] = [];
    for (const { tag } of svgTags(definition, true)) {
      if (/^<\/?clipPath\b/.test(tag)) continue;
      if (!/^<path\b/.test(tag) || /\s(?:clip-path|style|mask|filter)=/.test(tag)) return null;
      const paths = pathGeometry(attribute(tag, "d") ?? "", compose(clipMatrix, transformOf(tag)));
      if (!paths) return null;
      for (const path of paths) for (const p of path.points) points.push(p);
    }
    return hull(points);
  };
  const clipBounds = (reference: string, matrix: Matrix | null): GeometryBounds | null => {
    const id = /^url\(#([^)]*)\)$/.exec(reference)?.[1];
    if (!id || !matrix) return null;
    if (!clipCache.has(id)) clipCache.set(id, localClipBounds(id));
    const bounds = clipCache.get(id);
    return bounds ? rectangle(bounds, matrix) : null;
  };
  type Group = { matrix: Matrix | null; clip: boolean; unsupported: boolean; alpha: number; paintStyle?: boolean };
  const groups: Group[] = [{ matrix: IDENTITY, clip: false, unsupported: false, alpha: 1 }];
  let inDefinitions = false, count = 0;
  for (const { tag } of svgTags(svg)) {
    const name = /^<\/?([\w:]+)/.exec(tag)![1]!;
    if (name === "defs") { inDefinitions = !tag.startsWith("</") && !tag.endsWith("/>"); continue; }
    if (inDefinitions || name === "svg") continue;
    if (tag.startsWith("</")) {
      if (name === "g") groups.pop();
      continue;
    }
    const parent = groups.at(-1) ?? { matrix: null, clip: false, unsupported: true, alpha: Number.NaN };
    const matrix = compose(parent.matrix, transformOf(tag));
    const alpha = parent.alpha * opacity(tag, "opacity");
    const clipReference = attribute(tag, "clip-path");
    if (clipReference !== undefined && alpha !== 0) issue("clip_path", clipBounds(clipReference, matrix));
    const clip = parent.clip || clipReference !== undefined;
    const unsupported = parent.unsupported || !Number.isFinite(alpha) || /\s(?:style|mask|filter)=/.test(tag);
    if (name === "g") {
      if (!tag.endsWith("/>")) groups.push({ matrix, clip, unsupported, alpha, paintStyle: parent.paintStyle || /\s(?:fill|stroke|fill-opacity|stroke-opacity)=/.test(tag) });
      continue;
    }
    if (alpha === 0) continue;
    if (++count > 30_000) { geometry.complete = false; issue("vector_scan_limit"); break; }
    if (name === "use") {
      const id = (attribute(tag, "xlink:href") ?? attribute(tag, "href") ?? "").replace(/^#/, "");
      if (id.startsWith("glyph") && definitions.has(id)) {
        // Glyph outlines are positively identified text, not arbitrary filled vector paint.
        if (unsupported || !matrix) issue("unclassified_text_transform");
        continue;
      }
      const target = definitions.get(id);
      const width = Number(attribute(target ?? "", "width")), height = Number(attribute(target ?? "", "height"));
      const x = Number(attribute(tag, "x") ?? 0), y = Number(attribute(tag, "y") ?? 0);
      const bounds = target?.startsWith("<image") && matrix && width > 0 && height > 0
        ? rectangle({ x0: x, y0: y, x1: x+width, y1: y+height }, matrix) : null;
      issue(target?.startsWith("<image") ? "image_xobject" : "form_xobject", bounds);
      continue;
    }
    if (name === "image") {
      const x = Number(attribute(tag, "x") ?? 0), y = Number(attribute(tag, "y") ?? 0);
      const width = Number(attribute(tag, "width")), height = Number(attribute(tag, "height"));
      issue("image_xobject", matrix && width > 0 && height > 0
        ? rectangle({ x0: x, y0: y, x1: x+width, y1: y+height }, matrix) : null);
      continue;
    }
    if (name !== "path") { issue("unclassified_content"); continue; }
    const parsed = pathGeometry(attribute(tag, "d") ?? "", matrix);
    if (!parsed) { issue("unclassified_path"); continue; }
    const stroke = attribute(tag, "stroke"), fill = attribute(tag, "fill") ?? "black";
    const width = stroke && stroke !== "none" ? Number(attribute(tag, "stroke-width") ?? 1) : 0;
    const miter = Number(attribute(tag, "stroke-miterlimit") ?? 4);
    const strokeAlpha = alpha * opacity(tag, "stroke-opacity"), fillAlpha = alpha * opacity(tag, "fill-opacity");
    const hasStroke = stroke !== undefined && stroke !== "none" && strokeAlpha !== 0 && width !== 0;
    const hasFill = fill !== "none" && fillAlpha !== 0;
    const colour = strokeColour(stroke ?? "none");
    const expand = (bounds: GeometryBounds): GeometryBounds | null => {
      if (!Number.isFinite(width) || width < 0 || !Number.isFinite(miter) || miter < 1 || !matrix) return null;
      // Preserve the round-16 erasure margin, now independently around each segment.
      const dx = width/2 * miter * Math.hypot(matrix[0], matrix[2]);
      const dy = width/2 * miter * Math.hypot(matrix[1], matrix[3]);
      return { x0: bounds.x0-dx, x1: bounds.x1+dx, y0: bounds.y0-dy, y1: bounds.y1+dy };
    };
    const uncertain = unsupported || parent.paintStyle || !Number.isFinite(strokeAlpha) ||
      !Number.isFinite(fillAlpha) || attribute(tag, "stroke-dasharray") !== undefined;
    for (const subpath of parsed) {
      const fillBounds = hull(subpath.points)!;
      const thinBar = hasFill && black(fill) && subpath.segments.length === 4 &&
        subpath.segments.every(({ rule: r }) => r && (Math.abs(r.x0-r.x1) < 0.01 || Math.abs(r.y0-r.y1) < 0.01)) &&
        Math.min(fillBounds.x1-fillBounds.x0, fillBounds.y1-fillBounds.y0) <= 2;
      if (hasFill) issue("fill", fillBounds);
      for (const segment of subpath.segments) {
        const bounds = expand(segment.bounds);
        if (uncertain || !bounds) issue("unclassified_path", bounds);
        if (hasStroke) {
          if (!segment.rule) issue("curve", bounds);
          if (colour === "white") issue("white_stroke", bounds);
          if (colour === "unknown") issue("unclassified_stroke", bounds);
        }
        if (!clip && !uncertain && bounds && segment.rule && ((hasStroke && colour === "colour") || thinBar)) {
          if (rules.length >= 2_000) { geometry.complete = false; issue("border_limit"); break; }
          rules.push(segment.rule);
        }
      }
    }
  }
  const borders = mergeHorizontalBorders(rules.filter((r) => Math.abs(r.y0-r.y1) < 0.01 && Math.abs(r.x0-r.x1) > 1)
    .map((r) => ({ x0: Math.min(r.x0, r.x1), x1: Math.max(r.x0, r.x1), y: r.y0 })));
  return { borders, vectorGeometry: geometry };
}

export function geometryIssuesInRegion(geometry: PageVectorGeometry | undefined, region: GeometryBounds | undefined): string[] {
  if (!geometry) return ["vector_geometry_unavailable"];
  const causes = geometry.complete ? [] : ["vector_geometry_incomplete"];
  for (const issue of geometry.issues) {
    const b = issue.bounds;
    // Inspect a small margin around both label and value, including paint just beyond a cell edge.
    const margin = 2;
    if (!region || !b || (b.x0 <= region.x1+margin && b.x1 >= region.x0-margin &&
      b.y0 <= region.y1+margin && b.y1 >= region.y0-margin)) causes.push(issue.cause);
  }
  return [...new Set(causes)];
}
