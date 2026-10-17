/**
 * Static reachability for the capability manifest (OVD-825).
 *
 * Nothing here trusts the manifest: each entry point is resolved against the
 * code a production user actually hits, with no build flags set by hand and no
 * platform admin rights.
 *
 * - Routes: parsed from the app router. A route is gated when it only renders
 *   behind an `import.meta.env` value (VITE_ENABLE_*, DEV, ...), when its page
 *   only renders behind such a value, or when it is admin-only (staff path
 *   prefix or a platform admin admission check in the page).
 * - Links: the target route is reachable and some shipped source navigates to it.
 * - Webhooks: a Vercel function under api/ (after vercel.json rewrites) or a
 *   Supabase edge function, not switched off by a demo flag. For channel
 *   surfaces any production function named after the channel also counts;
 *   demo-only paths under scripts/ never do.
 */
import ts from "typescript";
import type { CapabilitySurface, ChannelName, EntryPoint } from "./capability-manifest";

/** Repo-relative, forward-slash paths. */
export interface SourceReader {
  read(path: string): string | null;
  /** Every file below `dir`, recursively. */
  list(dir: string): readonly string[];
}

export type RouteGate =
  | { readonly kind: "flag"; readonly flags: readonly string[]; readonly where: string }
  | { readonly kind: "admin"; readonly reason: string };

export interface ResolvedRoute {
  readonly path: string;
  readonly componentFile: string | null;
  readonly gates: readonly RouteGate[];
}

export interface EntryPointResult {
  readonly entryPoint: EntryPoint;
  readonly reachable: boolean;
  readonly detail: string;
}

export type SurfaceStatus = "reachable" | "unreachable" | "knownMissing" | "nowReachable";

export interface SurfaceResult {
  readonly id: string;
  readonly reachable: boolean;
  readonly status: SurfaceStatus;
  readonly entryPoints: readonly EntryPointResult[];
  readonly channelHandlers: readonly string[];
  readonly demoOnly: readonly string[];
  readonly failure: string | null;
}

export const APP_ROUTER_FILE = "src/App.tsx";

/** Staff and developer areas; a non-admin customer never lands here. */
const ADMIN_PATH_PREFIXES = ["/internal", "/debug", "/dev-login", "/dev/"];

/** Page-level admission checks that turn non-admins away. */
const ADMIN_PAGE_MARKERS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /api_get_is_platform_admin/, reason: "server platform admin admission" },
  { pattern: /if\s*\(\s*!\s*isPlatformAdmin\s*\)/, reason: "client platform admin guard" },
];

/** Page-level build switches that render the page only in a flagged build. */
const PAGE_FLAG_PATTERNS: readonly { pattern: RegExp; flag: (match: RegExpExecArray) => string }[] = [
  { pattern: /import\.meta\.env\.(DEV|VITE_ENABLE_\w+)/g, flag: (match) => match[1] },
  { pattern: /\bisFixtureModeAvailable\s*\(/g, flag: () => "VITE_ENABLE_FIXTURE_MODE" },
];

const DEMO_HANDLER_MARKERS = /DEMO_ENABLED|LOCAL_DEMO|synthetic demo/i;

const CHANNEL_KEYWORDS: Record<ChannelName, RegExp> = {
  slack: /slack/i,
  telegram: /telegram/i,
  imessage: /imessage|bluebubbles/i,
};

function sortStrings(values: Iterable<string>): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

function resolveModule(reader: SourceReader, fromFile: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = `src/${specifier.slice(2)}`;
  else if (specifier.startsWith(".")) base = normalize(`${dirname(fromFile)}/${specifier}`);
  else return null;
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, `${base}/index.tsx`, `${base}/index.ts`]) {
    if (reader.read(candidate) !== null) return candidate;
  }
  return null;
}

function envFlagName(node: ts.Node): string | null {
  // import.meta.env.X
  if (
    ts.isPropertyAccessExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === "env"
    && ts.isMetaProperty(node.expression.expression)
  ) {
    return node.name.text;
  }
  return null;
}

/**
 * Walks the app router source. Top-level declarations are indexed so a
 * condition such as `EngineeringAdminRoute && <Route .../>` can be traced to
 * the `import.meta.env` value that decides it.
 */
class RouterModule {
  private readonly declarations = new Map<string, ts.Expression>();
  private readonly imports = new Map<string, string>();
  readonly sourceFile: ts.SourceFile;

  constructor(readonly file: string, source: string) {
    this.sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    for (const statement of this.sourceFile.statements) {
      if (ts.isImportDeclaration(statement)) this.indexImport(statement);
      if (ts.isVariableStatement(statement)) this.indexDeclarations(statement);
    }
  }

  private indexImport(statement: ts.ImportDeclaration): void {
    if (!ts.isStringLiteral(statement.moduleSpecifier)) return;
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause?.name) this.imports.set(clause.name.text, specifier);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) this.imports.set(element.name.text, specifier);
    }
  }

  private indexDeclarations(statement: ts.VariableStatement): void {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        this.declarations.set(declaration.name.text, declaration.initializer);
      }
    }
  }

  /** Every `import.meta.env` value an expression depends on, through local constants. */
  envFlags(node: ts.Node, seen = new Set<string>()): string[] {
    const flags = new Set<string>();
    const visit = (current: ts.Node) => {
      const flag = envFlagName(current);
      if (flag) {
        flags.add(flag);
        return;
      }
      if (ts.isIdentifier(current) && !seen.has(current.text)) {
        const initializer = this.declarations.get(current.text);
        if (initializer) {
          seen.add(current.text);
          for (const nested of this.envFlags(initializer, seen)) flags.add(nested);
        }
      }
      ts.forEachChild(current, visit);
    };
    visit(node);
    return sortStrings(flags);
  }

  /** The local file a component identifier renders, via import or `lazy(() => import(...))`. */
  componentSpecifier(name: string): string | null {
    const imported = this.imports.get(name);
    if (imported) return imported;
    const initializer = this.declarations.get(name);
    if (!initializer) return null;
    let specifier: string | null = null;
    const visit = (node: ts.Node) => {
      if (
        !specifier
        && ts.isCallExpression(node)
        && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments[0]
        && ts.isStringLiteral(node.arguments[0])
      ) {
        specifier = node.arguments[0].text;
      }
      ts.forEachChild(node, visit);
    };
    visit(initializer);
    return specifier;
  }
}

function jsxAttribute(element: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return element.attributes.properties.find(
    (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText() === name,
  );
}

function stringAttribute(element: ts.JsxOpeningLikeElement, name: string): string | null {
  const initializer = jsxAttribute(element, name)?.initializer;
  if (!initializer) return null;
  if (ts.isStringLiteral(initializer)) return initializer.text;
  if (ts.isJsxExpression(initializer) && initializer.expression && ts.isStringLiteralLike(initializer.expression)) {
    return initializer.expression.text;
  }
  return null;
}

/** Conditions that must be truthy for `node` to render (the `a` in `a && x` and in `a ? x : y`). */
function renderConditions(node: ts.Node, stop: ts.Node): ts.Expression[] {
  const conditions: ts.Expression[] = [];
  let child = node;
  let parent = node.parent;
  while (parent && parent !== stop) {
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && parent.right === child) {
      conditions.push(parent.left);
    }
    if (ts.isConditionalExpression(parent) && parent.whenTrue === child) {
      conditions.push(parent.condition);
    }
    child = parent;
    parent = parent.parent;
  }
  return conditions;
}

function pageGates(reader: SourceReader, file: string): RouteGate[] {
  const source = reader.read(file) ?? "";
  const gates: RouteGate[] = [];
  const flags = new Set<string>();
  for (const { pattern, flag } of PAGE_FLAG_PATTERNS) {
    for (const match of source.matchAll(new RegExp(pattern.source, pattern.flags))) flags.add(flag(match));
  }
  if (flags.size > 0) gates.push({ kind: "flag", flags: sortStrings(flags), where: file });
  for (const { pattern, reason } of ADMIN_PAGE_MARKERS) {
    if (pattern.test(source)) gates.push({ kind: "admin", reason: `${reason} in ${file}` });
  }
  return gates;
}

function isJsxTag(node: ts.Node): node is ts.JsxSelfClosingElement | ts.JsxOpeningElement {
  return ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node);
}

/** Tag names of every JSX element below `node`, in source order. */
function jsxTagNames(node: ts.Node): string[] {
  const tagNames: string[] = [];
  const collect = (current: ts.Node) => {
    if (isJsxTag(current)) tagNames.push(current.tagName.getText());
    ts.forEachChild(current, collect);
  };
  collect(node);
  return tagNames;
}

/** Flags in the `&&` / `?:` conditions around the `<Route>`. */
function routeConditionGates(router: RouterModule, node: ts.JsxSelfClosingElement | ts.JsxOpeningElement): RouteGate[] {
  const routeNode = ts.isJsxOpeningElement(node) ? node.parent : node;
  const conditionFlags = renderConditions(routeNode, router.sourceFile).flatMap((condition) => router.envFlags(condition));
  if (conditionFlags.length === 0) return [];
  return [{ kind: "flag", flags: sortStrings(new Set(conditionFlags)), where: `${router.file} route condition` }];
}

/** The first local page the route element renders, and the gates of every local component in it. */
function routeElementGates(
  reader: SourceReader,
  router: RouterModule,
  node: ts.JsxSelfClosingElement | ts.JsxOpeningElement,
): { componentFile: string | null; gates: RouteGate[] } {
  let componentFile: string | null = null;
  const gates: RouteGate[] = [];
  const element = jsxAttribute(node, "element")?.initializer;
  if (!element) return { componentFile, gates };
  for (const tagName of jsxTagNames(element)) {
    const specifier = router.componentSpecifier(tagName);
    const file = specifier ? resolveModule(reader, router.file, specifier) : null;
    if (!file) continue;
    const componentFlags = router.envFlags(ts.factory.createIdentifier(tagName));
    if (componentFlags.length > 0) {
      gates.push({ kind: "flag", flags: componentFlags, where: `${router.file} ${tagName}` });
    }
    componentFile ??= file;
    gates.push(...pageGates(reader, file));
  }
  return { componentFile, gates };
}

function adminPathGates(path: string): RouteGate[] {
  const adminPrefix = ADMIN_PATH_PREFIXES.find((prefix) => path === prefix.replace(/\/$/, "") || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`));
  return adminPrefix ? [{ kind: "admin", reason: `staff path ${adminPrefix}` }] : [];
}

/** One gate per distinct description, ignoring where it was found. */
function uniqueGates(gates: readonly RouteGate[]): RouteGate[] {
  const unique = new Map(gates.map((gate) => [describeGates([gate]).replace(/ \(.*\)$/, ""), gate]));
  return [...unique.values()];
}

function resolveRoute(reader: SourceReader, router: RouterModule, node: ts.Node): ResolvedRoute | null {
  if (!isJsxTag(node) || node.tagName.getText() !== "Route") return null;
  const path = stringAttribute(node, "path");
  if (path === null || path === "*") return null;
  const { componentFile, gates: elementGates } = routeElementGates(reader, router, node);
  const gates = [...routeConditionGates(router, node), ...elementGates, ...adminPathGates(path)];
  return { path, componentFile, gates: uniqueGates(gates) };
}

/** Every `<Route path=... element=...>` in the router, with what it takes to render it. */
export function resolveAppRoutes(reader: SourceReader, routerFile = APP_ROUTER_FILE): ResolvedRoute[] {
  const source = reader.read(routerFile);
  if (source === null) throw new Error(`App router ${routerFile} not found`);
  const router = new RouterModule(routerFile, source);
  const routes: ResolvedRoute[] = [];

  const visit = (node: ts.Node) => {
    const route = resolveRoute(reader, router, node);
    if (route) routes.push(route);
    ts.forEachChild(node, visit);
  };
  visit(router.sourceFile);
  return routes;
}

function segments(path: string): string[] {
  return path.split("?")[0].split("/").filter(Boolean);
}

/** True when the route pattern serves `path`; `:param` segments match anything. */
export function routeMatches(pattern: string, path: string): boolean {
  const want = segments(pattern);
  const have = segments(path);
  return want.length === have.length && want.every((segment, index) => segment.startsWith(":") || have[index].startsWith(":") || segment === have[index]);
}

function describeGates(gates: readonly RouteGate[]): string {
  return gates
    .map((gate) => (gate.kind === "flag" ? `flag-gated by ${gate.flags.join(", ")} (${gate.where})` : `admin-only (${gate.reason})`))
    .join("; ");
}

function resolveRouteEntry(routes: readonly ResolvedRoute[], path: string): { reachable: boolean; detail: string } {
  const matches = routes.filter((route) => routeMatches(route.path, path));
  if (matches.length === 0) return { reachable: false, detail: `no route in ${APP_ROUTER_FILE} serves ${path}` };
  const open = matches.find((route) => route.gates.length === 0);
  if (open) return { reachable: true, detail: `route ${open.path} -> ${open.componentFile ?? "inline element"}` };
  return { reachable: false, detail: `route ${path} is ${matches.map((route) => describeGates(route.gates)).join(" | ")}` };
}

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$|\/(__tests__|test-support|fixtures?)\//;

/** Staff and developer source: admin/internal component trees, Internal* and Engineering* pages, debug tools. */
const STAFF_SOURCE = /\/(admin|internal|debug)\/|\/pages\/(Internal|Commercial|Engineering|Dev)[A-Z]/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function resolveLinkEntry(
  reader: SourceReader,
  routes: readonly ResolvedRoute[],
  from: string,
  to: string,
): { reachable: boolean; detail: string } {
  const origin = resolveRouteEntry(routes, from);
  if (!origin.reachable) return { reachable: false, detail: `link origin ${from}: ${origin.detail}` };
  const target = resolveRouteEntry(routes, to);
  if (!target.reachable) return { reachable: false, detail: `link target ${to}: ${target.detail}` };
  const literal = new RegExp(
    `(?:\\bto\\s*=|\\bhref\\s*[=:]|navigate\\(|buildAppAwareHref\\()\\s*\\{?\\s*["'\`]${escapeRegExp(to)}(?:["'\`?#])`,
  );
  // A link only a gated page renders is not a front door for a non-admin user.
  const openPages = new Set(routes.filter((route) => route.gates.length === 0).map((route) => route.componentFile));
  const gatedPages = new Set(
    routes.filter((route) => route.gates.length > 0 && !openPages.has(route.componentFile)).map((route) => route.componentFile),
  );
  const linker = reader
    .list("src")
    .find(
      (file) =>
        /\.[jt]sx?$/.test(file)
        && !TEST_FILE.test(file)
        && !STAFF_SOURCE.test(file)
        && !gatedPages.has(file)
        && !ADMIN_PAGE_MARKERS.some(({ pattern }) => pattern.test(reader.read(file) ?? ""))
        && literal.test(reader.read(file) ?? ""),
    );
  return linker
    ? { reachable: true, detail: `${linker} links to ${to}` }
    : { reachable: false, detail: `no shipped non-admin source under src/ links to ${to}` };
}

interface VercelRewrite {
  source: string;
  destination: string;
}

function vercelRewrites(reader: SourceReader): VercelRewrite[] {
  const raw = reader.read("vercel.json");
  if (!raw) return [];
  const parsed = JSON.parse(raw) as { rewrites?: VercelRewrite[] };
  // The SPA catch-all serves index.html; it is not an HTTP handler.
  return (parsed.rewrites ?? []).filter((rewrite) => rewrite.destination !== "/index.html");
}

/** The production function file behind an HTTP path, if any. */
function functionFileFor(reader: SourceReader, path: string): string | null {
  let target = path.split("?")[0];
  const rewrite = vercelRewrites(reader).find((candidate) => candidate.source === target);
  if (rewrite) target = rewrite.destination.split("?")[0];
  const vercel = /^\/api\/(.+)$/.exec(target);
  if (vercel) {
    for (const candidate of [`api/${vercel[1]}.ts`, `api/${vercel[1]}.js`, `api/${vercel[1]}/index.ts`]) {
      if (reader.read(candidate) !== null) return candidate;
    }
  }
  const edge = /^\/functions\/v1\/([^/]+)$/.exec(target);
  if (edge && reader.read(`supabase/functions/${edge[1]}/index.ts`) !== null) return `supabase/functions/${edge[1]}/index.ts`;
  return null;
}

function isProductionHandler(reader: SourceReader, file: string): boolean {
  return !TEST_FILE.test(file) && !DEMO_HANDLER_MARKERS.test(reader.read(file) ?? "");
}

function resolveWebhookEntry(reader: SourceReader, path: string): { reachable: boolean; detail: string } {
  const file = functionFileFor(reader, path);
  if (!file) return { reachable: false, detail: `no api/ or supabase/functions handler serves ${path}` };
  if (!isProductionHandler(reader, file)) return { reachable: false, detail: `${file} is demo-only` };
  return { reachable: true, detail: `${path} -> ${file}` };
}

function isFunctionEntry(file: string): boolean {
  return (/^api\/.+\.[jt]s$/.test(file) || /^supabase\/functions\/[^/_][^/]*\/index\.ts$/.test(file)) && !TEST_FILE.test(file);
}

/** Production function files named after the channel (api/ and Supabase edge functions). */
export function findChannelHandlers(reader: SourceReader, channel: ChannelName): string[] {
  const keyword = CHANNEL_KEYWORDS[channel];
  const handlers = [...reader.list("api"), ...reader.list("supabase/functions")]
    .filter((file) => isFunctionEntry(file) && keyword.test(file) && isProductionHandler(reader, file));
  return sortStrings(handlers);
}

/** Non-production paths that mention the channel (reported, never counted). */
export function findDemoOnlyChannelPaths(reader: SourceReader, channel: ChannelName): string[] {
  const keyword = CHANNEL_KEYWORDS[channel];
  return sortStrings(
    reader.list("scripts/jarvis-demo").filter((file) => !TEST_FILE.test(file) && keyword.test(reader.read(file) ?? "")),
  );
}

function resolveEntryPoint(
  reader: SourceReader,
  routes: readonly ResolvedRoute[],
  entryPoint: EntryPoint,
): { reachable: boolean; detail: string } {
  switch (entryPoint.kind) {
    case "route":
      return resolveRouteEntry(routes, entryPoint.path);
    case "link":
      return resolveLinkEntry(reader, routes, entryPoint.from, entryPoint.to);
    case "webhook":
      return resolveWebhookEntry(reader, entryPoint.path);
  }
}

export function evaluateSurface(
  reader: SourceReader,
  surface: CapabilitySurface,
  routes: readonly ResolvedRoute[] = resolveAppRoutes(reader),
): SurfaceResult {
  const entryPoints = surface.entryPoints.map(
    (entryPoint): EntryPointResult => ({ entryPoint, ...resolveEntryPoint(reader, routes, entryPoint) }),
  );
  const channelHandlers = surface.channel ? findChannelHandlers(reader, surface.channel) : [];
  const demoOnly = surface.channel ? findDemoOnlyChannelPaths(reader, surface.channel) : [];
  const reachable = entryPoints.some((entry) => entry.reachable) || channelHandlers.length > 0;

  let status: SurfaceStatus;
  let failure: string | null = null;
  if (surface.knownMissing) {
    status = reachable ? "nowReachable" : "knownMissing";
    if (reachable) {
      failure = `surface ${surface.id} is now reachable; remove knownMissing (${surface.knownMissing.issue}) from e2e/journeys/capability-manifest.ts`;
    }
  } else {
    status = reachable ? "reachable" : "unreachable";
    if (!reachable) {
      const reasons = entryPoints.map((entry) => entry.detail);
      failure = `surface ${surface.id} has no reachable entry point: ${reasons.length > 0 ? reasons.join("; ") : "no entry points declared"}`;
    }
  }
  return { id: surface.id, reachable, status, entryPoints, channelHandlers, demoOnly, failure };
}

export function evaluateManifest(reader: SourceReader, manifest: readonly CapabilitySurface[]): SurfaceResult[] {
  const routes = resolveAppRoutes(reader);
  return manifest.map((surface) => evaluateSurface(reader, surface, routes));
}

function describeEntryPoint(entryPoint: EntryPoint): string {
  return entryPoint.kind === "link" ? `link ${entryPoint.from} -> ${entryPoint.to}` : `${entryPoint.kind} ${entryPoint.path}`;
}

/** One summary row per surface, then one indented row per entry point and channel evidence. */
export function formatReachabilityTable(results: readonly SurfaceResult[]): string {
  const rows: string[][] = [];
  for (const result of results) {
    rows.push([result.id, result.status, ""]);
    for (const entry of result.entryPoints) {
      rows.push([`  ${describeEntryPoint(entry.entryPoint)}`, entry.reachable ? "ok" : "no", entry.detail]);
    }
    for (const handler of result.channelHandlers) rows.push(["  channel handler", "ok", handler]);
    if (result.demoOnly.length > 0) rows.push(["  demo-only (not counted)", "-", result.demoOnly.join(", ")]);
  }
  const header = ["surface", "result", "evidence"];
  const widths = [0, 1].map((column) => Math.max(header[column].length, ...rows.map((row) => row[column].length)));
  const line = (row: string[]) => `${row[0].padEnd(widths[0])}  ${row[1].padEnd(widths[1])}  ${row[2]}`.trimEnd();
  return [line(header), line(header.map((cell, index) => "-".repeat(index < 2 ? widths[index] : cell.length))), ...rows.map(line)].join("\n");
}

/** In-memory reader for fixtures. */
export function memoryReader(files: Record<string, string>): SourceReader {
  return {
    read: (path) => files[path] ?? null,
    list: (dir) => Object.keys(files).filter((file) => file.startsWith(`${dir}/`)),
  };
}
