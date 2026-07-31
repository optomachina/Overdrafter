import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { ManufacturingCorpusArtifact } from "./manufacturingCorpusContract.js";
import {
  createManufacturingCorpusManifestDiagnostic,
  normalizeManufacturingCorpusManifestDiagnostics,
  type ManufacturingCorpusManifestDiagnostic,
  type ManufacturingCorpusManifestDiagnosticCode,
} from "./manufacturingCorpusFilesystemDiagnostics.js";

export type VerifyManufacturingCorpusArtifactFilesystemOptions = Readonly<{
  captureVerifiedBytes?: boolean;
  captureByteLimit?: number;
  /** @internal Receives no path, handle, bytes, or protected metadata. */
  beforeOpenForTest?: (artifactId: string) => Promise<void> | void;
  /** @internal Receives no path, handle, bytes, or protected metadata. */
  afterReadForTest?: (artifactId: string) => Promise<void> | void;
}>;
export type ManufacturingCorpusArtifactFilesystemResult = Readonly<{
  state: "failed" | "verified";
  diagnostics: readonly ManufacturingCorpusManifestDiagnostic[];
  verifiedBytes: Uint8Array | null;
}>;

type WalkedArtifact = Readonly<{
  candidate: string;
  stats: BigIntStats;
}>;
type WalkResult =
  | Readonly<{ code: ManufacturingCorpusManifestDiagnosticCode }>
  | WalkedArtifact;
type StreamResult = Readonly<{
  bytes: Uint8Array | null;
  exceededExpectedSize: boolean;
  sha256: string;
}>;

function artifactDiagnostic(
  code: ManufacturingCorpusManifestDiagnosticCode,
  artifactId: string,
) {
  return createManufacturingCorpusManifestDiagnostic(
    code,
    "artifact",
    artifactId,
  );
}

function failed(
  artifactId: string,
  ...codes: ManufacturingCorpusManifestDiagnosticCode[]
): ManufacturingCorpusArtifactFilesystemResult {
  return {
    state: "failed",
    diagnostics: normalizeManufacturingCorpusManifestDiagnostics(
      codes.map((code) => artifactDiagnostic(code, artifactId)),
    ),
    verifiedBytes: null,
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

function statsMatch(left: BigIntStats, right: BigIntStats) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function filesystemErrorCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

async function walkArtifact(
  canonicalRoot: string,
  relativePath: string,
): Promise<WalkResult> {
  const candidate = path.resolve(canonicalRoot, relativePath);
  if (!containedBy(canonicalRoot, candidate)) {
    return { code: "artifact_path_escape" };
  }
  const components = relativePath.split("/");
  let cursor = canonicalRoot;
  let finalStats: BigIntStats | null = null;
  for (const [index, component] of components.entries()) {
    cursor = path.join(cursor, component);
    try {
      const stats = await lstat(cursor, { bigint: true });
      if (stats.isSymbolicLink()) {
        return { code: "artifact_symlink" };
      }
      const isFinal = index === components.length - 1;
      if (!isFinal && !stats.isDirectory()) {
        return { code: "artifact_path_missing" };
      }
      if (isFinal && !stats.isFile()) {
        return { code: "artifact_not_regular_file" };
      }
      if (isFinal) {
        finalStats = stats;
      }
    } catch {
      return { code: "artifact_path_missing" };
    }
  }
  if (finalStats === null) {
    return { code: "artifact_path_missing" };
  }
  try {
    const canonicalPath = await realpath(candidate);
    if (!containedBy(canonicalRoot, canonicalPath)) {
      return { code: "artifact_path_escape" };
    }
    return { candidate, stats: finalStats };
  } catch {
    return { code: "artifact_path_missing" };
  }
}

async function streamHandle(
  handle: FileHandle,
  captureBytes: boolean,
  expectedSize: number,
): Promise<StreamResult> {
  const bytes = captureBytes ? new Uint8Array(expectedSize) : null;
  const hash = createHash("sha256");
  let total = 0;
  while (true) {
    const buffer = new Uint8Array(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) {
      break;
    }
    const chunk = buffer.slice(0, bytesRead);
    if (total + bytesRead > expectedSize) {
      return {
        bytes: null,
        exceededExpectedSize: true,
        sha256: hash.digest("hex"),
      };
    }
    if (bytes !== null) {
      bytes.set(chunk, total);
    }
    total += bytesRead;
    hash.update(chunk);
  }
  return {
    bytes,
    exceededExpectedSize: false,
    sha256: hash.digest("hex"),
  };
}

async function pathStillMatches(
  canonicalRoot: string,
  relativePath: string,
  handleStats: BigIntStats,
) {
  const walked = await walkArtifact(canonicalRoot, relativePath);
  return "stats" in walked && statsMatch(walked.stats, handleStats);
}

/**
 * Roots must remain trusted and non-writable during validation. Node has no
 * portable openat-style traversal for pinning each parent directory.
 */
export async function verifyManufacturingCorpusArtifactFilesystem(
  artifact: ManufacturingCorpusArtifact,
  canonicalDirectoriesByRootId: ReadonlyMap<string, string>,
  options: VerifyManufacturingCorpusArtifactFilesystemOptions = {},
): Promise<ManufacturingCorpusArtifactFilesystemResult> {
  const root = canonicalDirectoriesByRootId.get(artifact.rootId);
  if (root === undefined) {
    return failed(artifact.artifactId, "artifact_root_missing");
  }
  const walked = await walkArtifact(root, artifact.relativePath);
  if ("code" in walked) {
    return failed(artifact.artifactId, walked.code);
  }

  let handle: FileHandle;
  try {
    if (options.beforeOpenForTest !== undefined) {
      await options.beforeOpenForTest(artifact.artifactId);
    }
    handle = await open(
      walked.candidate,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    const errorCode = filesystemErrorCode(error);
    let code: ManufacturingCorpusManifestDiagnosticCode =
      "artifact_open_failed";
    if (errorCode === "ELOOP") {
      code = "artifact_symlink";
    } else if (errorCode === "ENOENT") {
      code = "artifact_changed_during_validation";
    }
    return failed(artifact.artifactId, code);
  }

  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      !statsMatch(walked.stats, before) ||
      !(await pathStillMatches(root, artifact.relativePath, before))
    ) {
      return failed(
        artifact.artifactId,
        "artifact_changed_during_validation",
      );
    }
    if (before.size !== BigInt(artifact.byteSize)) {
      return failed(artifact.artifactId, "artifact_size_mismatch");
    }
    if (
      options.captureVerifiedBytes === true &&
      options.captureByteLimit !== undefined &&
      before.size > BigInt(options.captureByteLimit)
    ) {
      return failed(
        artifact.artifactId,
        "artifact_capture_limit_exceeded",
      );
    }
    const streamed = await streamHandle(
      handle,
      options.captureVerifiedBytes === true,
      artifact.byteSize,
    );
    if (options.afterReadForTest !== undefined) {
      await options.afterReadForTest(artifact.artifactId);
    }
    const after = await handle.stat({ bigint: true });
    if (
      !statsMatch(before, after) ||
      !(await pathStillMatches(root, artifact.relativePath, after))
    ) {
      return failed(
        artifact.artifactId,
        "artifact_changed_during_validation",
      );
    }
    if (streamed.exceededExpectedSize) {
      return failed(artifact.artifactId, "artifact_size_mismatch");
    }

    if (streamed.sha256 !== artifact.sha256) {
      return failed(artifact.artifactId, "artifact_sha256_mismatch");
    }
    return {
      state: "verified",
      diagnostics: [],
      verifiedBytes:
        streamed.bytes === null ? null : new Uint8Array(streamed.bytes),
    };
  } catch {
    return failed(artifact.artifactId, "artifact_read_failed");
  } finally {
    await handle.close().catch(() => undefined);
  }
}
