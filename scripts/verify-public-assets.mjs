import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BLOCKED_PUBLIC_ASSET_BASENAMES = new Set([
  "1093-05589-02.step",
  "1093-05589-02.stp",
  "1093-05589-02.pdf",
]);

export const BLOCKED_PUBLIC_ASSET_SHA256 = new Set([
  // Former STEP bytes served by the production app.
  "4111602b512ea575c010184f904675c92b8977028088c372033a7754d1e9f043",
  // Former scrubbed PDF bytes served by the production app.
  "4c1a151a9c642137a2d98c2ea1d2b1381db0ef28b8ca819d3fa360e26f861962",
  // Pre-scrub PDF bytes that remain reachable in the public repository history.
  "27174801d4eed4cebaa136055551855ed5376589061a16d4c509dc2ad722459e",
]);

export const BLOCKED_PUBLIC_ASSET_MARKERS = [
  Buffer.from("1093-05589", "utf8"),
];

const PUBLIC_BINARY_EXTENSIONS = new Set([
  ".asm",
  ".drw",
  ".iges",
  ".igs",
  ".pdf",
  ".prt",
  ".sldasm",
  ".slddrw",
  ".sldprt",
  ".step",
  ".stp",
  ".x_t",
  ".xt",
]);
const APPROVED_PUBLIC_BINARY_SHA256 = new Map([
  [
    "demo-bracket-drawing.pdf",
    "c3cc2e2ff915791eda05b9385ea4855071c7dfdf310e197530a05d7f32615d0a",
  ],
  [
    "demo-bracket.step",
    "ce3a738daa238f2fcaa48cbed28ac4da3a9cdfedc1f4154cde8526bda5616372",
  ],
]);

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function containsBuffer(haystack, needle) {
  return haystack.includes(needle);
}

/**
 * Returns every containment-policy violation for one candidate public file.
 */
export function inspectPublicAsset(filePath, contents, policy = {}) {
  const blockedBasenames = policy.blockedBasenames ?? BLOCKED_PUBLIC_ASSET_BASENAMES;
  const blockedHashes = policy.blockedHashes ?? BLOCKED_PUBLIC_ASSET_SHA256;
  const blockedMarkers = policy.blockedMarkers ?? BLOCKED_PUBLIC_ASSET_MARKERS;
  const approvedBinaryHashes = policy.approvedBinaryHashes ?? APPROVED_PUBLIC_BINARY_SHA256;
  const violations = [];
  const basename = path.basename(filePath).toLowerCase();
  const contentHash = sha256(contents);

  if (blockedBasenames.has(basename)) {
    violations.push(`blocked filename: ${basename}`);
  }

  if (blockedHashes.has(contentHash)) {
    violations.push(`blocked SHA-256: ${contentHash}`);
  }

  if (blockedMarkers.some((marker) => containsBuffer(contents, marker))) {
    violations.push("blocked validation-package identity marker");
  }

  const extension = path.extname(basename);
  if (PUBLIC_BINARY_EXTENSIONS.has(extension)) {
    const approvedHash = approvedBinaryHashes.get(basename);
    if (!approvedHash) {
      violations.push(`unapproved public binary: ${basename}`);
    } else if (approvedHash !== contentHash) {
      violations.push(`approved public binary hash mismatch: ${basename}`);
    }
  }

  return violations;
}

async function listFilesRecursively(rootPath, violations) {
  const entries = await readdir(rootPath, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(entryPath, violations)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    } else {
      violations.push(`${entryPath}: unsupported filesystem entry; public roots must contain regular files only`);
    }
  }

  return files;
}

/**
 * Scans one or more required roots and returns path-scoped policy violations.
 */
export async function scanPublicAssetRoots(rootPaths, policy) {
  const violations = [];

  for (const rootPath of rootPaths) {
    let rootStats;
    try {
      rootStats = await stat(rootPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        violations.push(`${rootPath}: required scan root does not exist`);
        continue;
      }
      throw error;
    }

    if (!rootStats.isDirectory()) {
      violations.push(`${rootPath}: required scan root is not a directory`);
      continue;
    }

    const files = await listFilesRecursively(rootPath, violations);
    for (const filePath of files) {
      const contents = await readFile(filePath);
      for (const violation of inspectPublicAsset(filePath, contents, policy)) {
        violations.push(`${filePath}: ${violation}`);
      }
    }
  }

  return violations.sort((left, right) => left.localeCompare(right));
}

async function main() {
  const requestedRoots = process.argv.slice(2);
  if (requestedRoots.length === 0) {
    throw new Error("Pass at least one required scan root, for example: public dist");
  }

  const rootPaths = requestedRoots.map((rootPath) => path.resolve(process.cwd(), rootPath));
  const violations = await scanPublicAssetRoots(rootPaths);

  if (violations.length > 0) {
    console.error("Public validation-asset containment check failed:");
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Public validation-asset containment check passed for ${requestedRoots.join(", ")}.`);
}

const isDirectExecution = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;

if (isDirectExecution) {
  await main();
}
