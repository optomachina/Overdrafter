import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  createManufacturingCorpusManifestDiagnostic,
  normalizeManufacturingCorpusManifestDiagnostics,
  type ManufacturingCorpusManifestDiagnostic,
  type ManufacturingCorpusManifestDiagnosticCode,
} from "./manufacturingCorpusFilesystemDiagnostics.js";
import type { LoadedManufacturingCorpusManifest } from "./manufacturingCorpusManifestLoader.js";

export type ResolvedManufacturingCorpusRootBindings = Readonly<{
  state: "resolved";
  canonicalDirectoriesByRootId: ReadonlyMap<string, string>;
  diagnostics: readonly [];
}>;
export type FailedManufacturingCorpusRootBindings = Readonly<{
  state: "failed";
  diagnostics: readonly ManufacturingCorpusManifestDiagnostic[];
}>;
export type ManufacturingCorpusRootBindingsResult =
  | FailedManufacturingCorpusRootBindings
  | ResolvedManufacturingCorpusRootBindings;
export type ResolveManufacturingCorpusRootBindingsOptions = Readonly<{
  /** @internal Path-free seam for canonical containment race tests. */
  afterComponentInspectionForTest?: (
    rootId: string,
  ) => Promise<void> | void;
}>;

type RootKind = "external" | "manifest";
type RootInspection =
  | Readonly<{ canonicalDirectory: string }>
  | Readonly<{ code: ManufacturingCorpusManifestDiagnosticCode }>;

function rootDiagnostic(
  code: ManufacturingCorpusManifestDiagnosticCode,
  rootId: string,
) {
  return createManufacturingCorpusManifestDiagnostic(code, "root", rootId);
}

function failure(
  diagnostics: readonly ManufacturingCorpusManifestDiagnostic[],
): FailedManufacturingCorpusRootBindings {
  return {
    state: "failed",
    diagnostics: normalizeManufacturingCorpusManifestDiagnostics(diagnostics),
  };
}

function containedBy(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function inspectComponents(
  start: string,
  components: readonly string[],
  kind: RootKind,
  afterInspection: (() => Promise<void> | void) | undefined,
): Promise<RootInspection> {
  let cursor = start;
  for (const component of components) {
    cursor = path.join(cursor, component);
    try {
      const stats = await lstat(cursor);
      if (stats.isSymbolicLink()) {
        return { code: `${kind}_root_symlink` };
      }
      if (!stats.isDirectory()) {
        return { code: `${kind}_root_not_directory` };
      }
    } catch {
      return { code: `${kind}_root_missing` };
    }
  }
  try {
    if (components.length === 0) {
      const stats = await lstat(cursor);
      if (stats.isSymbolicLink()) {
        return { code: `${kind}_root_symlink` };
      }
      if (!stats.isDirectory()) {
        return { code: `${kind}_root_not_directory` };
      }
    }
    if (afterInspection !== undefined) {
      await afterInspection();
    }
    return { canonicalDirectory: await realpath(cursor) };
  } catch {
    return { code: `${kind}_root_missing` };
  }
}

async function resolveManifestRoot(
  canonicalManifestDirectory: string,
  relativePath: string,
  afterInspection: (() => Promise<void> | void) | undefined,
): Promise<RootInspection> {
  const components = relativePath === "." ? [] : relativePath.split("/");
  const candidate = path.resolve(canonicalManifestDirectory, relativePath);
  if (!containedBy(canonicalManifestDirectory, candidate)) {
    return { code: "manifest_root_escape" };
  }
  const inspected = await inspectComponents(
    canonicalManifestDirectory,
    components,
    "manifest",
    afterInspection,
  );
  if ("code" in inspected) {
    return inspected;
  }
  if (!containedBy(canonicalManifestDirectory, inspected.canonicalDirectory)) {
    return { code: "manifest_root_escape" };
  }
  return inspected;
}

async function resolveExternalRoot(
  binding: string,
  afterInspection: (() => Promise<void> | void) | undefined,
): Promise<RootInspection> {
  if (!path.isAbsolute(binding)) {
    return { code: "external_root_binding_not_absolute" };
  }
  const absolute = path.resolve(binding);
  const parsed = path.parse(absolute);
  const relative = path.relative(parsed.root, absolute);
  const components = relative === "" ? [] : relative.split(path.sep);
  const inspected = await inspectComponents(
    parsed.root,
    components,
    "external",
    afterInspection,
  );
  if (
    "canonicalDirectory" in inspected &&
    inspected.canonicalDirectory !== absolute
  ) {
    return { code: "external_root_symlink" };
  }
  return inspected;
}

/**
 * Resolves roots without opening artifacts.
 *
 * Node has no portable openat-style directory traversal. Callers must keep the
 * manifest directory and external mount hierarchy trusted and non-writable
 * while this resolution context is in use.
 */
export async function resolveManufacturingCorpusRootBindings(
  loaded: LoadedManufacturingCorpusManifest,
  externalBindings: ReadonlyMap<string, string>,
  options: ResolveManufacturingCorpusRootBindingsOptions = {},
): Promise<ManufacturingCorpusRootBindingsResult> {
  const diagnostics: ManufacturingCorpusManifestDiagnostic[] = [];
  const resolved = new Map<string, string>();
  const externalRoots = new Set(
    loaded.manifest.roots
      .filter((root) => root.kind === "external_mount")
      .map((root) => root.rootId),
  );

  for (const bindingId of externalBindings.keys()) {
    if (!externalRoots.has(bindingId)) {
      diagnostics.push(
        rootDiagnostic("external_root_unknown_binding", bindingId),
      );
    }
  }
  for (const root of loaded.manifest.roots) {
    const afterInspection =
      options.afterComponentInspectionForTest === undefined
        ? undefined
        : () => options.afterComponentInspectionForTest?.(root.rootId);
    let inspection: RootInspection;
    if (root.kind === "manifest_relative") {
      inspection = await resolveManifestRoot(
        loaded.canonicalManifestDirectory,
        root.relativePath,
        afterInspection,
      );
    } else {
      const binding = externalBindings.get(root.rootId);
      if (binding === undefined) {
        diagnostics.push(
          rootDiagnostic("external_root_unmounted", root.rootId),
        );
        continue;
      }
      inspection = await resolveExternalRoot(binding, afterInspection);
    }
    if ("code" in inspection) {
      diagnostics.push(rootDiagnostic(inspection.code, root.rootId));
    } else {
      resolved.set(root.rootId, inspection.canonicalDirectory);
    }
  }

  if (diagnostics.length > 0) {
    return failure(diagnostics);
  }
  return {
    state: "resolved",
    canonicalDirectoriesByRootId: resolved,
    diagnostics: [],
  };
}

/** Serializes status and path-free diagnostics, never canonical directories. */
export function serializeManufacturingCorpusRootBindingsResult(
  result: ManufacturingCorpusRootBindingsResult,
) {
  const publicResult =
    result.state === "failed"
      ? {
          state: result.state,
          diagnostics: normalizeManufacturingCorpusManifestDiagnostics(
            result.diagnostics,
          ),
        }
      : { state: result.state, diagnostics: [] };
  return `${JSON.stringify(publicResult, null, 2)}\n`;
}
