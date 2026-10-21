import type { TitleBlockBorder } from "./titleBlockCells.js";

export type GeometryBounds = { x0: number; y0: number; x1: number; y1: number };
export type GeometryIssue = { cause: string; bounds: GeometryBounds | null };
export type VectorRule = GeometryBounds;
export type PageVectorGeometry = {
  /** Positive proof of a complete scan in the word boxes' coordinate frame. */
  complete: boolean;
  issues: GeometryIssue[];
  width?: number;
  height?: number;
  rules?: VectorRule[];
};
type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const NUMBER = /[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi;
const attribute = (tag: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag)?.[1];
const numbers = (text: string) => text.match(NUMBER)?.map(Number) ?? [];
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
/** Cairo uses absolute M/L/C/Q/Z paths. Anything outside that grammar is unlocated evidence. */
function pathGeometry(data: string, matrix: Matrix | null) {
  if (!matrix || data.length > 1_000_000 || data.replace(/[MLCQZ]|[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?|[\s,]/gi, "") || /[mlcqz]/.test(data.replace(/e[-+]?\d+/gi, ""))) return null;
  const tokens = data.match(/[MLCQZ]|[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const points: [number, number][] = [], rules: VectorRule[] = [];
  let current: [number, number] | undefined, start: [number, number] | undefined;
  let curve = false;
  const edge = (end: [number, number]) => {
    if (current) rules.push({ x0: current[0], y0: current[1], x1: end[0], y1: end[1] });
    current = end;
  };
  for (let i = 0; i < tokens.length;) {
    const command = tokens[i++]!;
    if (command === "Z") { if (!start || !current) return null; edge(start); continue; }
    const count = command === "M" || command === "L" ? 2 : command === "C" ? 6 : command === "Q" ? 4 : 0;
    if (!count || i + count > tokens.length) return null;
    const coords = tokens.slice(i, i + count).map(Number);
    if (!coords.every(Number.isFinite)) return null;
    i += count;
    const part: [number, number][] = [];
    for (let j = 0; j < count; j += 2) part.push(point(coords[j]!, coords[j+1]!, matrix));
    points.push(...part);
    const end = part.at(-1)!;
    if (command === "M") { current = end; start = end; }
    else if (command === "L") { if (!current) return null; edge(end); }
    else { if (!current) return null; curve = true; current = end; }
  }
  return { bounds: hull(points), rules, curve };
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
    .map((name) => name.replace(/#([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))));
  const issues: GeometryIssue[] = [];
  if (names.has("/Form")) issues.push({ cause: "form_xobject", bounds: null });
  if (names.has("/ObjStm")) issues.push({ cause: "unclassified_pdf_object_stream", bounds: null });
  if (names.has("/Encrypt")) issues.push({ cause: "encrypted_pdf_geometry", bounds: null });
  return issues;
}

/** I7: unsupported paint is monotonic negative evidence, never a reason to discard earlier rules. */
export function readSvgGeometry(svg: string, pageSize: { width: number; height: number }): { borders: TitleBlockBorder[]; vectorGeometry: PageVectorGeometry } {
  const issues: GeometryIssue[] = [], rules: VectorRule[] = [];
  const geometry: PageVectorGeometry = { complete: true, issues, rules, ...pageSize };
  const issue = (cause: string, bounds: GeometryBounds | null = null) => {
    if (issues.length < 2_000) issues.push({ cause, bounds });
    else geometry.complete = false;
  };
  const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? "";
  const viewBox = numbers(attribute(root, "viewBox") ?? "");
  if (/\s(?:transform|style|clip-path|mask|filter)=/.test(root)) issue("unclassified_page_transform");
  if (!svg.trimEnd().endsWith("</svg>") || !root) { geometry.complete = false; issue("incomplete_svg"); }
  if (viewBox.length !== 4 || viewBox[0] !== 0 || viewBox[1] !== 0 ||
    !Number.isFinite(pageSize.width) || !Number.isFinite(pageSize.height) ||
    Math.abs(viewBox[2]! - pageSize.width) > 0.01 || Math.abs(viewBox[3]! - pageSize.height) > 0.01) {
    geometry.complete = false; issue("coordinate_frame_mismatch");
  }
  const definitions = new Map<string, string>();
  for (const match of svg.matchAll(/<(?:image|symbol|g|clipPath)\b[^>]*\bid="([^"]+)"[^>]*>/g)) definitions.set(match[1]!, match[0]);
  type Group = { matrix: Matrix | null; clip: boolean; unsupported: boolean; paintStyle?: boolean };
  const groups: Group[] = [{ matrix: IDENTITY, clip: false, unsupported: false }];
  let inDefinitions = false, count = 0;
  for (const match of svg.matchAll(/<\/?[A-Za-z][^>]*>/g)) {
    const tag = match[0], name = /^<\/?([\w:]+)/.exec(tag)![1]!;
    if (name === "defs") { inDefinitions = !tag.startsWith("</") && !tag.endsWith("/>"); continue; }
    if (inDefinitions || name === "svg") continue;
    if (tag.startsWith("</")) { if (name === "g") groups.pop(); continue; }
    const parent = groups.at(-1) ?? { matrix: null, clip: false, unsupported: true };
    const matrix = compose(parent.matrix, transformOf(tag));
    // The clip boundary itself is negative evidence, even when its painted child is elsewhere.
    // Its full coverage is not resolved by this reader, so it conservatively vetoes the page.
    if (attribute(tag, "clip-path") !== undefined) issue("clip_path");
    const clip = parent.clip || attribute(tag, "clip-path") !== undefined;
    const unsupported = parent.unsupported || /\s(?:style|mask|filter|opacity)=/.test(tag);
    if (name === "g") {
      if (!tag.endsWith("/>")) groups.push({ matrix, clip, unsupported, paintStyle: parent.paintStyle || /\s(?:fill|stroke|fill-opacity|stroke-opacity)=/.test(tag) });
      continue;
    }
    if (++count > 30_000) { geometry.complete = false; issue("vector_scan_limit"); break; }
    if (name === "use") {
      const id = (attribute(tag, "xlink:href") ?? attribute(tag, "href") ?? "").replace(/^#/, "");
      if (/^glyph/.test(id) && definitions.has(id)) {
        // Glyph outlines are positively identified text, not arbitrary filled vector paint.
        if (clip || unsupported || !matrix) issue(clip ? "clip_path" : "unclassified_text_transform");
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
    if (name !== "path") { issue(name === "image" ? "image_xobject" : "unclassified_content"); continue; }
    const parsed = pathGeometry(attribute(tag, "d") ?? "", matrix);
    if (!parsed) { issue("unclassified_path"); continue; }
    if (!parsed.bounds) continue; // Empty Cairo path paints nothing.
    const stroke = attribute(tag, "stroke"), fill = attribute(tag, "fill") ?? "black";
    const width = stroke && stroke !== "none" ? Number(attribute(tag, "stroke-width") ?? 1) : 0;
    const miter = Number(attribute(tag, "stroke-miterlimit") ?? 4);
    let bounds: GeometryBounds | null = parsed.bounds;
    if (!Number.isFinite(width) || width < 0 || !Number.isFinite(miter) || miter < 1 || !matrix) bounds = null;
    else {
      const dx = width/2 * miter * Math.hypot(matrix[0], matrix[2]);
      const dy = width/2 * miter * Math.hypot(matrix[1], matrix[3]);
      bounds = { x0: bounds.x0-dx, x1: bounds.x1+dx, y0: bounds.y0-dy, y1: bounds.y1+dy };
    }
    if (clip) issue("clip_path", bounds);
    if (unsupported || parent.paintStyle || !bounds || attribute(tag, "stroke-dasharray")) issue("unclassified_path", bounds);
    if (parsed.curve) issue("curve", bounds);
    if (fill !== "none") issue("fill", bounds);
    const solidBlackStroke = stroke !== undefined && stroke !== "none" && black(stroke) &&
      Number(attribute(tag, "stroke-opacity") ?? 1) === 1 && width > 0;
    if (stroke && stroke !== "none" && !solidBlackStroke) issue("non_black_or_light_stroke", bounds);
    const thinBar = fill !== "none" && black(fill) && !parsed.curve && parsed.rules.length === 4 &&
      parsed.rules.every((r) => Math.abs(r.x0-r.x1) < 0.01 || Math.abs(r.y0-r.y1) < 0.01) &&
      Math.min(parsed.bounds.x1-parsed.bounds.x0, parsed.bounds.y1-parsed.bounds.y0) <= 2;
    if (!clip && !unsupported && !parsed.curve && !attribute(tag, "stroke-dasharray") && (solidBlackStroke || thinBar)) {
      for (const rule of parsed.rules) {
        if (rules.length >= 2_000) { geometry.complete = false; issue("border_limit"); break; }
        rules.push(rule);
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
    if (!region || !b || (b.x0 <= region.x1 && b.x1 >= region.x0 && b.y0 <= region.y1 && b.y1 >= region.y0)) causes.push(issue.cause);
  }
  return [...new Set(causes)];
}
