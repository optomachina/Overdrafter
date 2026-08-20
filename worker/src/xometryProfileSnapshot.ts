import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";
import type { WorkerConfig } from "./types.js";

const execFileAsync = promisify(execFile);
const MANIFEST_NAME = ".overdrafter-profile.json";
const MANIFEST_SCHEMA = "overdrafter-xometry-profile.v1";
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const SNAPSHOT_REQUEST_TIMEOUT_MS = 30_000;

type SnapshotManifest = {
  schema: typeof MANIFEST_SCHEMA;
  browserEngine: WorkerConfig["xometryBrowserEngine"];
  savedAt: string;
};

type ObjectMetadata = {
  generation?: string;
  size?: string;
};

type AccessTokenResponse = {
  access_token?: string;
};

let snapshotLifecycleTail = Promise.resolve();

/** Serialize one complete snapshot-backed browser lifecycle per worker process. */
export async function withXometryProfileSnapshotLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = snapshotLifecycleTail;
  let release: () => void = () => undefined;
  snapshotLifecycleTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export class XometryProfileSnapshotError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
  ) {
    super(message);
    this.name = "XometryProfileSnapshotError";
  }
}

function snapshotConfigured(config: WorkerConfig) {
  return Boolean(
    config.xometryProfileSnapshotBucket &&
      config.xometryProfileSnapshotObject &&
      config.xometryUserDataDir,
  );
}

function objectMetadataUrl(bucket: string, object: string) {
  return `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}`;
}

function objectDownloadUrl(bucket: string, object: string, generation: string) {
  return `${objectMetadataUrl(bucket, object)}?alt=media&generation=${encodeURIComponent(generation)}`;
}

function objectUploadUrl(bucket: string, object: string, generation: string) {
  const base = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`;
  return `${base}?uploadType=media&name=${encodeURIComponent(object)}&ifGenerationMatch=${encodeURIComponent(generation)}`;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutReason: "snapshot_read_failed" | "snapshot_write_failed",
) {
  try {
    return await fetchImpl(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(SNAPSHOT_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new XometryProfileSnapshotError(
        "Profile snapshot request timed out.",
        timeoutReason,
      );
    }
    throw error;
  }
}

async function accessToken(
  fetchImpl: typeof fetch,
  timeoutReason: "snapshot_read_failed" | "snapshot_write_failed",
) {
  const response = await fetchWithTimeout(
    fetchImpl,
    METADATA_TOKEN_URL,
    { headers: { "Metadata-Flavor": "Google" } },
    timeoutReason,
  );
  if (!response.ok) {
    throw new XometryProfileSnapshotError(
      `Profile snapshot credential request failed with HTTP ${response.status}.`,
      "credential_unavailable",
    );
  }
  const payload = (await response.json()) as AccessTokenResponse;
  if (!payload.access_token) {
    throw new XometryProfileSnapshotError(
      "Profile snapshot credential response did not contain an access token.",
      "credential_unavailable",
    );
  }
  return payload.access_token;
}

async function authenticatedFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit = {},
  timeoutReason: "snapshot_read_failed" | "snapshot_write_failed" = "snapshot_read_failed",
) {
  const token = await accessToken(fetchImpl, timeoutReason);
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetchWithTimeout(fetchImpl, url, { ...init, headers }, timeoutReason);
}

async function boundedBody(response: Response, maxBytes: number) {
  const declaredSize = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    throw new XometryProfileSnapshotError(
      "Profile snapshot exceeds the configured size limit.",
      "snapshot_too_large",
    );
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new XometryProfileSnapshotError(
      "Profile snapshot response did not include a body.",
      "snapshot_missing_body",
    );
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new XometryProfileSnapshotError(
        "Profile snapshot exceeds the configured size limit.",
        "snapshot_too_large",
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

function safeArchiveEntry(entry: string) {
  const normalized = entry.replace(/^\.\//, "").replace(/\/$/, "");
  if (!normalized) return true;
  if (path.posix.isAbsolute(normalized)) return false;
  return !normalized.split("/").some((segment) => segment === "..");
}

async function validateArchive(archivePath: string) {
  let stdout: string;
  let verboseOutput: string;
  try {
    ({ stdout } = await execFileAsync("tar", ["-tzf", archivePath], {
      maxBuffer: 4 * 1024 * 1024,
    }));
    ({ stdout: verboseOutput } = await execFileAsync("tar", ["-tvzf", archivePath], {
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch {
    throw new XometryProfileSnapshotError(
      "Profile snapshot is not a readable gzip archive.",
      "snapshot_corrupt",
    );
  }
  const entries = stdout.split("\n").filter(Boolean);
  if (entries.length === 0 || entries.length > 100_000) {
    throw new XometryProfileSnapshotError(
      "Profile snapshot has an invalid entry count.",
      "snapshot_corrupt",
    );
  }
  if (entries.some((entry) => !safeArchiveEntry(entry))) {
    throw new XometryProfileSnapshotError(
      "Profile snapshot contains an unsafe path.",
      "snapshot_unsafe_path",
    );
  }
  const unsafeEntryType = verboseOutput
    .split("\n")
    .filter(Boolean)
    .some((entry) => entry[0] !== "-" && entry[0] !== "d");
  if (unsafeEntryType) {
    throw new XometryProfileSnapshotError(
      "Profile snapshot contains a link or unsupported filesystem entry.",
      "snapshot_unsafe_entry",
    );
  }
  if (!entries.some((entry) => entry.replace(/^\.\//, "") === MANIFEST_NAME)) {
    throw new XometryProfileSnapshotError(
      "Profile snapshot manifest is missing.",
      "snapshot_manifest_missing",
    );
  }
}

async function validateClosedCamoufoxProfile(userDataDir: string) {
  const lockPath = path.join(userDataDir, "lock");
  let target: string;
  try {
    target = await fs.readlink(lockPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    throw new XometryProfileSnapshotError(
      "Camoufox profile lock is not a readable singleton link.",
      "snapshot_unsafe_entry",
    );
  }

  const pidMatch = target.match(/(?:\+|-)(\d+)$/);
  const pid = Number.parseInt(pidMatch?.[1] ?? "", 10);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new XometryProfileSnapshotError(
      "Camoufox profile lock has an unsupported target.",
      "snapshot_unsafe_entry",
    );
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw new XometryProfileSnapshotError(
      "Camoufox profile lock owner could not be verified as stopped.",
      "snapshot_unsafe_entry",
    );
  }
  throw new XometryProfileSnapshotError(
    "Camoufox profile is still in use and cannot be archived.",
    "snapshot_unsafe_entry",
  );
}

type TarInspectionState = {
  buffered: Buffer;
  payloadBytesRemaining: number;
  totalFileBytes: number;
};

function parseTarEntrySize(header: Buffer) {
  const encoded = header.subarray(124, 136);
  if ((encoded[0] & 0x80) === 0) {
    const sizeText = encoded.toString("ascii").replace(/\0.*$/, "").trim();
    return Number.parseInt(sizeText || "0", 8);
  }
  if ((encoded[0] & 0x40) !== 0) return Number.NaN;
  let size = BigInt(encoded[0] & 0x3f);
  for (const byte of encoded.subarray(1)) {
    size = (size << 8n) | BigInt(byte);
  }
  return size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(size) : Number.NaN;
}

function consumeTarChunk(state: TarInspectionState, chunk: Buffer, maxBytes: number) {
  state.buffered = Buffer.concat([state.buffered, chunk]);
  for (;;) {
    if (state.payloadBytesRemaining > 0) {
      const consumed = Math.min(state.payloadBytesRemaining, state.buffered.length);
      state.buffered = state.buffered.subarray(consumed);
      state.payloadBytesRemaining -= consumed;
      if (state.payloadBytesRemaining > 0) return false;
    }
    if (state.buffered.length < 512) return false;
    const header = state.buffered.subarray(0, 512);
    state.buffered = state.buffered.subarray(512);
    if (header.every((value) => value === 0)) return true;
    const size = parseTarEntrySize(header);
    if (!Number.isFinite(size) || size < 0) {
      throw new XometryProfileSnapshotError(
        "Profile snapshot contains an invalid file size.",
        "snapshot_corrupt",
      );
    }
    state.totalFileBytes += size;
    if (state.totalFileBytes > maxBytes) {
      throw new XometryProfileSnapshotError(
        "Profile snapshot expands beyond the configured size limit.",
        "snapshot_too_large",
      );
    }
    state.payloadBytesRemaining = Math.ceil(size / 512) * 512;
  }
}

async function validateUncompressedSize(archivePath: string, maxBytes: number) {
  const stream = createReadStream(archivePath).pipe(createGunzip());
  const state: TarInspectionState = {
    buffered: Buffer.alloc(0),
    payloadBytesRemaining: 0,
    totalFileBytes: 0,
  };

  try {
    for await (const chunk of stream) {
      if (consumeTarChunk(state, Buffer.from(chunk), maxBytes)) return;
    }
  } catch (error) {
    if (error instanceof XometryProfileSnapshotError) throw error;
    throw new XometryProfileSnapshotError(
      "Profile snapshot could not be inspected safely.",
      "snapshot_corrupt",
    );
  }
}

async function validateManifest(config: WorkerConfig) {
  if (!config.xometryUserDataDir) {
    throw new XometryProfileSnapshotError(
      "Profile snapshot mode did not resolve a local profile directory.",
      "profile_directory_missing",
    );
  }
  let parsed: SnapshotManifest;
  try {
    const raw = await fs.readFile(path.join(config.xometryUserDataDir, MANIFEST_NAME), "utf8");
    parsed = JSON.parse(raw) as SnapshotManifest;
  } catch {
    throw new XometryProfileSnapshotError(
      "Profile snapshot manifest is invalid.",
      "snapshot_manifest_invalid",
    );
  }
  if (parsed.schema !== MANIFEST_SCHEMA || parsed.browserEngine !== config.xometryBrowserEngine) {
    throw new XometryProfileSnapshotError(
      "Profile snapshot is incompatible with the configured browser engine.",
      "snapshot_incompatible",
    );
  }

  const cookieDatabase =
    config.xometryBrowserEngine === "camoufox"
      ? path.join(config.xometryUserDataDir, "cookies.sqlite")
      : path.join(config.xometryUserDataDir, "Default", "Cookies");
  try {
    const cookieStat = await fs.stat(cookieDatabase);
    if (!cookieStat.isFile()) throw new Error("not a file");
  } catch {
    throw new XometryProfileSnapshotError(
      "Profile snapshot does not contain the expected browser cookie database.",
      "snapshot_profile_uninitialized",
    );
  }
}

/** Restore a closed-browser profile snapshot into a fresh local directory. */
export async function restoreXometryProfileSnapshot(
  config: WorkerConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkerConfig> {
  if (!snapshotConfigured(config)) return config;
  const bucket = config.xometryProfileSnapshotBucket as string;
  const object = config.xometryProfileSnapshotObject as string;
  const userDataDir = config.xometryUserDataDir as string;

  const metadataResponse = await authenticatedFetch(fetchImpl, objectMetadataUrl(bucket, object));
  if (!metadataResponse.ok) {
    throw new XometryProfileSnapshotError(
      `Profile snapshot metadata request failed with HTTP ${metadataResponse.status}.`,
      metadataResponse.status === 404 ? "snapshot_missing" : "snapshot_read_failed",
    );
  }
  const metadata = (await metadataResponse.json()) as ObjectMetadata;
  const generation = metadata.generation;
  const size = Number.parseInt(metadata.size ?? "", 10);
  if (!generation) {
    throw new XometryProfileSnapshotError(
      "Profile snapshot metadata did not contain an object generation.",
      "snapshot_generation_missing",
    );
  }
  if (!Number.isFinite(size) || size <= 0 || size > config.xometryProfileSnapshotMaxBytes) {
    throw new XometryProfileSnapshotError(
      "Profile snapshot metadata contains an invalid size.",
      "snapshot_too_large",
    );
  }

  const downloadResponse = await authenticatedFetch(
    fetchImpl,
    objectDownloadUrl(bucket, object, generation),
  );
  if (!downloadResponse.ok) {
    throw new XometryProfileSnapshotError(
      `Profile snapshot download failed with HTTP ${downloadResponse.status}.`,
      "snapshot_read_failed",
    );
  }

  const archive = await boundedBody(downloadResponse, config.xometryProfileSnapshotMaxBytes);
  const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "overdrafter-xometry-restore-"));
  const archivePath = path.join(archiveDir, "profile.tgz");
  try {
    await fs.writeFile(archivePath, archive, { mode: 0o600 });
    await validateArchive(archivePath);
    await validateUncompressedSize(archivePath, config.xometryProfileSnapshotMaxBytes);
    await fs.rm(userDataDir, { recursive: true, force: true });
    await fs.mkdir(userDataDir, { recursive: true, mode: 0o700 });
    await execFileAsync("tar", ["-xzf", archivePath, "-C", userDataDir, "--no-same-owner", "--no-same-permissions"]);
    await validateManifest(config);
  } finally {
    await fs.rm(archiveDir, { recursive: true, force: true });
  }

  return { ...config, xometryProfileSnapshotGeneration: generation };
}

/** Persist a profile only after its browser context has fully closed. */
export async function persistXometryProfileSnapshot(
  config: WorkerConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkerConfig> {
  if (!snapshotConfigured(config)) return config;
  if (!config.xometryProfileSnapshotGeneration || !config.xometryUserDataDir) {
    throw new XometryProfileSnapshotError(
      "Profile snapshot generation is unavailable; refusing an unguarded write.",
      "snapshot_generation_missing",
    );
  }

  const archiveDir = await fs.mkdtemp(path.join(os.tmpdir(), "overdrafter-xometry-save-"));
  const archivePath = path.join(archiveDir, "profile.tgz");
  try {
    await createXometryProfileArchive({
      userDataDir: config.xometryUserDataDir,
      browserEngine: config.xometryBrowserEngine,
      outputPath: archivePath,
      maxBytes: config.xometryProfileSnapshotMaxBytes,
    });
    const stat = await fs.stat(archivePath);
    if (stat.size <= 0 || stat.size > config.xometryProfileSnapshotMaxBytes) {
      throw new XometryProfileSnapshotError(
        "Profile snapshot exceeds the configured size limit.",
        "snapshot_too_large",
      );
    }
    const body = await fs.readFile(archivePath);
    const response = await authenticatedFetch(
      fetchImpl,
      objectUploadUrl(
        config.xometryProfileSnapshotBucket as string,
        config.xometryProfileSnapshotObject as string,
        config.xometryProfileSnapshotGeneration,
      ),
      { method: "POST", headers: { "Content-Type": "application/gzip" }, body },
      "snapshot_write_failed",
    );
    if (!response.ok) {
      throw new XometryProfileSnapshotError(
        `Profile snapshot write failed with HTTP ${response.status}.`,
        response.status === 412 ? "snapshot_generation_conflict" : "snapshot_write_failed",
      );
    }
    const metadata = (await response.json()) as ObjectMetadata;
    if (!metadata.generation) {
      throw new XometryProfileSnapshotError(
        "Profile snapshot write response did not contain a generation.",
        "snapshot_generation_missing",
      );
    }
    return { ...config, xometryProfileSnapshotGeneration: metadata.generation };
  } finally {
    await fs.rm(archiveDir, { recursive: true, force: true });
  }
}

/** Create the closed-browser archive used to seed snapshot storage. */
export async function createXometryProfileArchive(input: {
  userDataDir: string;
  browserEngine: WorkerConfig["xometryBrowserEngine"];
  outputPath: string;
  maxBytes?: number;
}) {
  if (input.browserEngine === "camoufox") {
    await validateClosedCamoufoxProfile(input.userDataDir);
  }
  const maxBytes = input.maxBytes ?? 268435456;
  const manifest: SnapshotManifest = {
    schema: MANIFEST_SCHEMA,
    browserEngine: input.browserEngine,
    savedAt: new Date().toISOString(),
  };
  await fs.writeFile(
    path.join(input.userDataDir, MANIFEST_NAME),
    JSON.stringify(manifest),
    { mode: 0o600 },
  );

  const validationConfig = {
    xometryUserDataDir: input.userDataDir,
    xometryBrowserEngine: input.browserEngine,
  } as WorkerConfig;
  await validateManifest(validationConfig);
  await fs.mkdir(path.dirname(input.outputPath), { recursive: true });
  await execFileAsync("tar", [
    "-czf",
    input.outputPath,
    "--exclude=./SingletonLock",
    "--exclude=./SingletonSocket",
    "--exclude=./SingletonCookie",
    "--exclude=./lock",
    "-C",
    input.userDataDir,
    ".",
  ]);
  const stat = await fs.stat(input.outputPath);
  if (stat.size <= 0 || stat.size > maxBytes) {
    throw new XometryProfileSnapshotError(
      "Profile snapshot exceeds the configured size limit.",
      "snapshot_too_large",
    );
  }
  await validateArchive(input.outputPath);
  await validateUncompressedSize(input.outputPath, maxBytes);
}
