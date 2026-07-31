import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import {
  manufacturingCorpusManifestSchema,
  type ManufacturingCorpusManifest,
} from "./manufacturingCorpusContract.js";
import {
  createManufacturingCorpusManifestDiagnostic,
  normalizeManufacturingCorpusManifestDiagnostics,
  type ManufacturingCorpusManifestDiagnostic,
  type ManufacturingCorpusManifestDiagnosticCode,
  type ManufacturingCorpusManifestDiagnosticRecordKind,
} from "./manufacturingCorpusFilesystemDiagnostics.js";

/** Default cap for untrusted manifest metadata; callers may lower or raise it. */
export const DEFAULT_MANUFACTURING_CORPUS_MANIFEST_BYTE_LIMIT =
  8 * 1024 * 1024;

export type LoadManufacturingCorpusManifestOptions = Readonly<{
  manifestByteLimit?: number;
  /** @internal Deterministic and path-free; used only for drift tests. */
  afterOpenForTest?: () => Promise<void> | void;
}>;
export type LoadedManufacturingCorpusManifest = Readonly<{
  state: "loaded";
  manifest: ManufacturingCorpusManifest;
  manifestSha256: string;
  /** Internal input for later root resolution. Never publicly serialized. */
  canonicalManifestDirectory: string;
  diagnostics: readonly [];
}>;
export type FailedManufacturingCorpusManifestLoad = Readonly<{
  state: "failed";
  diagnostics: readonly ManufacturingCorpusManifestDiagnostic[];
}>;
export type ManufacturingCorpusManifestLoadResult =
  | FailedManufacturingCorpusManifestLoad
  | LoadedManufacturingCorpusManifest;

type ReadResult = Readonly<{ bytes: Uint8Array; sha256: string }>;
type PathInspection =
  | Readonly<{ code: ManufacturingCorpusManifestDiagnosticCode }>
  | Readonly<{ stats: BigIntStats }>;
const stableIdPattern = /^[a-z0-9][a-z0-9._-]*$/;

function diagnostic(
  code: ManufacturingCorpusManifestDiagnosticCode,
  kind: ManufacturingCorpusManifestDiagnosticRecordKind,
  id: string | null = null,
) {
  return createManufacturingCorpusManifestDiagnostic(code, kind, id);
}

function failed(
  diagnostics: readonly ManufacturingCorpusManifestDiagnostic[],
): FailedManufacturingCorpusManifestLoad {
  return {
    state: "failed",
    diagnostics: normalizeManufacturingCorpusManifestDiagnostics(diagnostics),
  };
}

const manifestFailure = (code: ManufacturingCorpusManifestDiagnosticCode) =>
  failed([diagnostic(code, "manifest")]);

function statsMatch(left: BigIntStats, right: BigIntStats) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readHandle(
  handle: FileHandle,
  byteLimit: number,
): Promise<ReadResult | null> {
  const chunks: Uint8Array[] = [];
  const hash = createHash("sha256");
  let total = 0;
  while (true) {
    const buffer = new Uint8Array(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) {
      break;
    }
    total += bytesRead;
    if (total > byteLimit) {
      return null;
    }
    const chunk = buffer.slice(0, bytesRead);
    chunks.push(chunk);
    hash.update(chunk);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, sha256: hash.digest("hex") };
}

function filesystemErrorCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

async function inspectPath(
  manifestPath: string,
  byteLimit: number,
): Promise<PathInspection> {
  try {
    const stats = await lstat(manifestPath, { bigint: true });
    if (stats.isSymbolicLink()) {
      return { code: "manifest_symlink" };
    }
    if (!stats.isFile()) {
      return { code: "manifest_not_regular_file" };
    }
    if (stats.size > BigInt(byteLimit)) {
      return { code: "manifest_too_large" };
    }
    return { stats };
  } catch (error) {
    return {
      code: filesystemErrorCode(error) === "ENOENT"
        ? "manifest_missing"
        : "manifest_read_failed",
    };
  }
}

function rawArray(value: unknown, key: string): readonly unknown[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const candidate = (value as Record<string, unknown>)[key];
  return Array.isArray(candidate) ? candidate : [];
}

function rawString(value: unknown, key: string) {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : null;
}

function duplicates(
  values: readonly unknown[],
  identity: (value: unknown) => string | null,
  code: ManufacturingCorpusManifestDiagnosticCode,
  kind: ManufacturingCorpusManifestDiagnosticRecordKind,
) {
  const counts = new Map<string, number>();
  for (const value of values) {
    const id = identity(value);
    if (id !== null && stableIdPattern.test(id)) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => diagnostic(code, kind, id));
}

function findDuplicateIdentities(raw: unknown) {
  const result: ManufacturingCorpusManifestDiagnostic[] = [];
  const fields = [
    ["roots", "rootId", "duplicate_root_id", "root"],
    ["rights", "rightsId", "duplicate_rights_id", "rights"],
    ["cases", "caseId", "duplicate_case_id", "case"],
  ] as const;
  for (const [collection, field, code, kind] of fields) {
    result.push(
      ...duplicates(
        rawArray(raw, collection),
        (value) => rawString(value, field),
        code,
        kind,
      ),
    );
  }
  const targetIdentity = (value: unknown) => {
    const process = rawString(value, "processFamily");
    const target = rawString(value, "qualificationTarget");
    return process !== null && target !== null
      ? `${process}.${target}`
      : null;
  };
  result.push(
    ...duplicates(
      rawArray(raw, "targets"),
      targetIdentity,
      "duplicate_target_identity",
      "target",
    ),
  );
  const artifacts = rawArray(raw, "cases").flatMap((corpusCase) => {
    const values = [...rawArray(corpusCase, "artifacts")];
    if (typeof corpusCase === "object" && corpusCase !== null) {
      const annotation = (corpusCase as Record<string, unknown>)
        .annotationArtifact;
      if (annotation !== undefined) {
        values.push(annotation);
      }
    }
    return values;
  });
  result.push(
    ...duplicates(
      artifacts,
      (value) => rawString(value, "artifactId"),
      "duplicate_artifact_id",
      "artifact",
    ),
  );
  return result;
}

async function readVerifiedManifest(
  manifestPath: string,
  pathStats: BigIntStats,
  byteLimit: number,
  afterOpenForTest: (() => Promise<void> | void) | undefined,
): Promise<FailedManufacturingCorpusManifestLoad | ReadResult> {
  let handle: FileHandle;
  try {
    handle = await open(
      manifestPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    return manifestFailure(
      filesystemErrorCode(error) === "ELOOP"
        ? "manifest_symlink"
        : "manifest_read_failed",
    );
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) {
      return manifestFailure("manifest_not_regular_file");
    }
    if (before.size > BigInt(byteLimit)) {
      return manifestFailure("manifest_too_large");
    }
    if (!statsMatch(pathStats, before)) {
      return manifestFailure("manifest_changed_during_validation");
    }
    if (afterOpenForTest !== undefined) {
      await afterOpenForTest();
    }
    const read = await readHandle(handle, byteLimit);
    const after = await handle.stat({ bigint: true });
    if (!statsMatch(before, after)) {
      return manifestFailure("manifest_changed_during_validation");
    }
    return read ?? manifestFailure("manifest_too_large");
  } catch {
    return manifestFailure("manifest_read_failed");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function loadManufacturingCorpusManifest(
  manifestPath: string,
  options: LoadManufacturingCorpusManifestOptions = {},
): Promise<ManufacturingCorpusManifestLoadResult> {
  const byteLimit =
    options.manifestByteLimit ??
    DEFAULT_MANUFACTURING_CORPUS_MANIFEST_BYTE_LIMIT;
  if (!Number.isSafeInteger(byteLimit) || byteLimit <= 0) {
    return manifestFailure("manifest_byte_limit_invalid");
  }
  const resolvedPath = path.resolve(manifestPath);
  const inspection = await inspectPath(resolvedPath, byteLimit);
  if ("code" in inspection) {
    return manifestFailure(inspection.code);
  }
  const read = await readVerifiedManifest(
    resolvedPath,
    inspection.stats,
    byteLimit,
    options.afterOpenForTest,
  );
  if ("state" in read) {
    return read;
  }

  let raw: unknown;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    raw = JSON.parse(decoder.decode(read.bytes));
  } catch {
    return manifestFailure("manifest_json_invalid");
  }
  const diagnostics = findDuplicateIdentities(raw);
  const parsed = manufacturingCorpusManifestSchema.safeParse(raw);
  if (!parsed.success) {
    diagnostics.push(diagnostic("manifest_schema_invalid", "manifest"));
  }
  if (!parsed.success || diagnostics.length > 0) {
    return failed(diagnostics);
  }
  try {
    return {
      state: "loaded",
      manifest: parsed.data,
      manifestSha256: read.sha256,
      canonicalManifestDirectory: await realpath(path.dirname(resolvedPath)),
      diagnostics: [],
    };
  } catch {
    return manifestFailure("manifest_read_failed");
  }
}

/** Serializes public metadata without the manifest body or canonical path. */
export function serializeManufacturingCorpusManifestLoadResult(
  result: ManufacturingCorpusManifestLoadResult,
) {
  const publicResult =
    result.state === "failed"
      ? {
          state: result.state,
          diagnostics: normalizeManufacturingCorpusManifestDiagnostics(
            result.diagnostics,
          ),
        }
      : {
          state: result.state,
          manifestSha256: result.manifestSha256,
          diagnostics: [],
        };
  return `${JSON.stringify(publicResult, null, 2)}\n`;
}
