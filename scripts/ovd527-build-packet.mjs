#!/usr/bin/env node
/**
 * OVD-527 build qualification packet.
 *
 * Blaine runs three subcommands in order:
 *   source   --sha <full sha>                          clean source archive and manifest
 *   commands --sha <full sha>                          exact build, resolve and inspection commands
 *   bundle   --build-json <file> --inspect-json <file> bundle accepted by attestBuildOnly
 *
 * This tool only reads Git, hashes files and validates saved outputs. It never
 * runs gcloud or docker; Blaine runs the printed commands himself.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { OVD419_DIGEST_CONTRACT, isDirectCli, isFullSha } from "./ovd419-digest-contract.mjs";
import { attestBuildOnly } from "./run-ovd419-final-digest-release.mjs";

export const PACKET_SCHEMA = "ovd527-build-packet-v1";
export const SOURCE_PREFIX = "worker";
export const BUILDER_IMAGE = "gcr.io/cloud-builders/docker";
export const PLATFORM = "linux/amd64";
export const RUNTIME_USER = "pwuser";

// Absolute path, matching the other repository scripts, so PATH cannot pick the binary.
const GIT_BIN = "/usr/bin/git";
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CAMOUFOX_VERSION_PATH = "/home/pwuser/.cache/camoufox/version.json";
const CAMOUFOX_VERSION_PATTERN =
  /printf '%s' '(\{[^']*\})' > \/home\/pwuser\/\.cache\/camoufox\/version\.json/;

/** Source files copied unchanged into the final image, keyed by image path. */
export const CRITICAL_SOURCE_FILES = Object.freeze([
  Object.freeze({ imagePath: "/app/package.json", sourcePath: "worker/package.json" }),
  Object.freeze({ imagePath: "/app/package-lock.json", sourcePath: "worker/package-lock.json" }),
  Object.freeze({
    imagePath: "/app/scripts/install-camoufox.mjs",
    sourcePath: "worker/scripts/install-camoufox.mjs",
  }),
]);

/** Runtime assets the final image must contain. `exec` requires an executable file. */
export const REQUIRED_RUNTIME_ASSETS = Object.freeze([
  Object.freeze({ path: "/app/dist/index.js", test: "-f" }),
  Object.freeze({ path: "/app/node_modules", test: "-d" }),
  Object.freeze({ path: "/home/pwuser/.cache/camoufox/camoufox-bin", test: "-x" }),
  Object.freeze({ path: "/home/pwuser/.cache/camoufox/addons/UBO/manifest.json", test: "-f" }),
  Object.freeze({ path: "/ms-playwright", test: "-d" }),
  Object.freeze({ path: "/usr/bin/tesseract", test: "-x" }),
  Object.freeze({ path: "/usr/bin/pdftoppm", test: "-x" }),
  Object.freeze({ path: "/usr/bin/Xvfb", test: "-x" }),
  Object.freeze({ path: "/root/.cache/overdrafter-worker", test: "-d" }),
]);

const MMDB_SEARCH_ROOTS = Object.freeze([
  "/app",
  "/home/pwuser/.cache",
  "/ms-playwright",
  "/root/.cache/overdrafter-worker",
]);

export class PacketError extends Error {
  constructor(message, failures = []) {
    super(message);
    this.name = "PacketError";
    this.failures = failures;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function imageTag(source) {
  return `ovd527-${source.commit}-${source.archiveSha256.slice(0, 12)}`;
}

export function taggedImage(source) {
  return `${OVD419_DIGEST_CONTRACT.imageRepository}:${imageTag(source)}`;
}

export function defaultPacketDir(sha) {
  return path.join(os.homedir(), "ovd527-packet", sha);
}

/* ------------------------------------------------------------------ */
/* Tar reading                                                          */
/* ------------------------------------------------------------------ */

function readCString(block, start, length) {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function readOctal(block, start, length) {
  const text = readCString(block, start, length).trim();
  if (!/^[0-7]+$/.test(text)) throw new PacketError("source archive has an invalid tar header");
  return Number.parseInt(text, 8);
}

function parsePax(bytes) {
  const records = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(bytes.subarray(offset, space).toString("utf8"), 10);
    if (!Number.isSafeInteger(length) || length <= 0) {
      throw new PacketError("source archive has an invalid pax record");
    }
    const record = bytes.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

/** Read entries of an uncompressed tar produced by `git archive`. */
export function readTarEntries(tar) {
  const entries = [];
  let globalPax = {};
  let nextPax = {};
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "g") {
      globalPax = { ...globalPax, ...parsePax(body) };
      continue;
    }
    if (type === "x") {
      nextPax = parsePax(body);
      continue;
    }
    const prefix = readCString(header, 345, 155);
    const name = readCString(header, 0, 100);
    const entryPath = nextPax.path ?? (prefix ? `${prefix}/${name}` : name);
    const linkName = nextPax.linkpath ?? readCString(header, 157, 100);
    nextPax = {};
    entries.push({
      path: entryPath,
      type,
      mode: readOctal(header, 100, 8).toString(8).padStart(4, "0"),
      size,
      body: type === "2" ? Buffer.from(linkName, "utf8") : Buffer.from(body),
    });
  }
  return { entries, globalPax };
}

/** Build the toolchain independent manifest text for one archive. */
export function manifestFromTar(tar, commit) {
  const { entries, globalPax } = readTarEntries(tar);
  if (globalPax.comment !== commit) {
    throw new PacketError("source archive commit comment does not match the requested SHA");
  }
  const lines = [];
  const files = new Map();
  for (const entry of entries) {
    if (entry.type === "5") continue;
    if (entry.type !== "0" && entry.type !== "2") {
      throw new PacketError(`source archive has unsupported entry type for ${entry.path}`);
    }
    if (!entry.path.startsWith(`${SOURCE_PREFIX}/`)) {
      throw new PacketError(`source archive has a path outside ${SOURCE_PREFIX}/`);
    }
    const kind = entry.type === "2" ? "link" : "file";
    const hash = sha256(entry.body);
    lines.push(`${hash} ${kind} ${entry.mode} ${entry.body.length} ${entry.path}`);
    files.set(entry.path, { kind, hash, body: entry.body });
  }
  lines.sort((left, right) => {
    const a = left.split(" ").slice(4).join(" ");
    const b = right.split(" ").slice(4).join(" ");
    if (a < b) return -1;
    return a > b ? 1 : 0;
  });
  const text = [
    "ovd527-source-manifest-v1",
    `commit ${commit}`,
    `prefix ${SOURCE_PREFIX}/`,
    `entries ${lines.length}`,
    ...lines,
    "",
  ].join("\n");
  return { text, files };
}

/** Gzip with a fixed header so the same tar and Node zlib give the same bytes. */
export function gzipArchive(tar) {
  const gz = Buffer.from(gzipSync(tar, { level: 9 }));
  gz.writeUInt32LE(0, 4); // mtime
  gz[9] = 255; // operating system: unknown
  return gz;
}

/** Derive critical file expectations from the archive contents. */
export function criticalFileHashes(files) {
  const critical = CRITICAL_SOURCE_FILES.map(({ imagePath, sourcePath }) => {
    const file = files.get(sourcePath);
    if (!file || file.kind !== "file") {
      throw new PacketError(`source archive is missing ${sourcePath}`);
    }
    return { imagePath, sourcePath, sha256: file.hash };
  });
  const dockerfile = files.get(`${SOURCE_PREFIX}/Dockerfile`);
  const match = dockerfile?.body.toString("utf8").match(CAMOUFOX_VERSION_PATTERN);
  if (!match) {
    throw new PacketError("worker/Dockerfile no longer writes the pinned Camoufox version.json");
  }
  critical.push({
    imagePath: CAMOUFOX_VERSION_PATH,
    sourcePath: "worker/Dockerfile (pinned printf literal)",
    sha256: sha256(Buffer.from(match[1], "utf8")),
  });
  return critical;
}

/* ------------------------------------------------------------------ */
/* Build configuration and commands                                    */
/* ------------------------------------------------------------------ */

export function expectedBuildStep(source) {
  return {
    name: BUILDER_IMAGE,
    dir: SOURCE_PREFIX,
    args: [
      "build",
      `--platform=${PLATFORM}`,
      "--build-arg",
      `WORKER_BUILD_VERSION=${source.commit}`,
      "--tag",
      taggedImage(source),
      ".",
    ],
  };
}

export function buildTags(source) {
  return [
    "ovd527-build-only",
    `ovd527-commit-${source.commit}`,
    `ovd527-archive-${source.archiveSha256}`,
    `ovd527-manifest-${source.manifestSha256}`,
  ];
}

/** Cloud Build configuration: one docker build step, one pushed image, no deploy. */
export function cloudBuildConfig(source) {
  return {
    steps: [expectedBuildStep(source)],
    images: [taggedImage(source)],
    tags: buildTags(source),
    options: { sourceProvenanceHash: ["SHA256"] },
  };
}

export function shellDouble(text) {
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
}

/**
 * Fallback tunnel devices that some Linux kernels create in every network
 * namespace when the tunnel modules are built in (Docker Desktop's VM kernel
 * does this, so `docker run --network=none` lists them next to lo). They carry
 * no route or address. They count as "no network" only while administratively
 * down (IFF_UP, bit 0x1, clear); any other interface, or any of these up,
 * means the runtime had a network. Flags are 32-bit kernel values, so only 1-8
 * hex digits are accepted; anything longer fails closed.
 */
export const KERNEL_FALLBACK_TUNNEL_DEVICES = Object.freeze(new Set([
  "tunl0", "ip6tnl0", "sit0", "gre0", "gretap0", "erspan0",
  "ip6gre0", "ip_vti0", "ip6_vti0",
]));

export function runtimeNetworkDisabled(interfaces) {
  if (!Array.isArray(interfaces) || interfaces.length === 0) return false;
  let loopbacks = 0;
  for (const entry of interfaces) {
    const [name, flags, ...rest] = String(entry).split(":");
    if (rest.length > 0) return false;
    if (name === "lo") { loopbacks += 1; continue; }
    if (!KERNEL_FALLBACK_TUNNEL_DEVICES.has(name)) return false;
    if (!/^0x[0-9a-f]{1,8}$/i.test(flags ?? "")) return false;
    if ((Number.parseInt(flags, 16) & 0x1) !== 0) return false;
  }
  return loopbacks === 1;
}

/**
 * Shell script run inside the image with networking disabled. It prints one
 * JSON object and never starts the worker entrypoint. It contains no single
 * quotes so the printed command can wrap it in single quotes.
 */
export function containerInspectionScript(source) {
  const fileFields = source.criticalFiles.map(
    ({ imagePath }) => `\\"${imagePath}\\":\\"$(h ${imagePath})\\"`,
  );
  const assetFields = REQUIRED_RUNTIME_ASSETS.map(
    ({ path: assetPath, test }) => `\\"${assetPath}\\":$(t ${test} ${assetPath})`,
  );
  const lines = [
    'h() { if [ -f "$1" ] && [ ! -L "$1" ]; then sha256sum "$1" | cut -d " " -f 1; else echo missing; fi; }',
    't() { if [ "$1" "$2" ]; then echo true; else echo false; fi; }',
    'n=0; for f in /proc/[0-9]*/cmdline; do a=$(tr "\\000" "\\n" < "$f" 2>/dev/null | head -n 1); case "$a" in node|*/node) n=$((n+1));; esac; done',
    `m=$(find ${MMDB_SEARCH_ROOTS.join(" ")} -iname "*.mmdb" 2>/dev/null | wc -l | tr -d " ")`,
    'i=$(for d in /sys/class/net/*; do [ -d "$d" ] || continue; printf "%s:%s " "${d##*/}" "$(cat "$d/flags" 2>/dev/null || echo x)"; done)',
    `printf "%s\\n" "{\\"schema\\":\\"ovd527-container-v1\\",\\"buildVersion\\":\\"$WORKER_BUILD_VERSION\\",\\"machine\\":\\"$(uname -m)\\",\\"user\\":\\"$(id -un)\\",\\"netInterfaces\\":\\"$i\\",\\"nodeProcessCount\\":$n,\\"mmdbCount\\":$m,\\"criticalFiles\\":{${fileFields.join(",")}},\\"assets\\":{${assetFields.join(",")}}}"`,
  ];
  const script = lines.join("; ");
  if (script.includes("'")) throw new PacketError("inspection script must not contain single quotes");
  return script;
}

/**
 * The seven printed steps in order. Steps 1-5 need GCP access (step 5 also a
 * local Docker); steps 6 and 7 are local. `targets` redirects where steps 3
 * and 5 write, so a wrapper can write a partial file and rename it.
 */
export function commandSteps(source, packetDir, targets = {}) {
  const { project, region, imageRepository } = OVD419_DIGEST_CONTRACT;
  const tag = imageTag(source);
  const archive = path.join(packetDir, "source.tgz");
  const config = path.join(packetDir, "cloudbuild.json");
  const buildJson = path.join(packetDir, "build.json");
  const inspectJson = path.join(packetDir, "inspect.json");
  const bundleJson = path.join(packetDir, "bundle.json");
  const script = containerInspectionScript(source);
  return {
    submit: `# 1. Submit the build. Must print one build id.
BUILD_ID="$(gcloud builds submit ${shellDouble(archive)} \\
  --project=${project} --region=${region} \\
  --config=${shellDouble(config)} \\
  --async --format='value(id)')"
echo "$BUILD_ID"
`,
    follow: `# 2. Follow the build log. Must end with the image pushed and status SUCCESS.
#    The only step is "${BUILDER_IMAGE} build --platform=${PLATFORM}
#    --build-arg WORKER_BUILD_VERSION=${source.commit}".
gcloud builds log "$BUILD_ID" --project=${project} --region=${region} --stream
`,
    saveBuild: `# 3. Save the build record, the digest resolve and the tag list in one file.
#    The build must show status SUCCESS, exactly one step, the four ovd527 tags,
#    and a SHA256 source provenance hash equal to the archive SHA-256 above.
#    The resolve and the single matching tag entry must show the same digest.
{ printf '{"build":'
  gcloud builds describe "$BUILD_ID" --project=${project} --region=${region} --format=json
  printf ',"resolve":'
  gcloud artifacts docker images describe "${imageRepository}:${tag}" --project=${project} --format=json
  printf ',"tags":'
  gcloud artifacts docker tags list "${imageRepository}" --project=${project} --format=json
  printf '}\\n'
} > ${shellDouble(targets.buildJson ?? buildJson)}
`,
    pin: `# 4. Pin the immutable image by digest. Must print ${imageRepository}@sha256:<64 hex>.
IMAGE="${imageRepository}@$(gcloud artifacts docker images describe "${imageRepository}:${tag}" --project=${project} --format='value(image_summary.digest)')"
echo "$IMAGE"
`,
    inspect: `# 5. Pull and inspect offline: ${PLATFORM}, --network=none, worker entrypoint replaced
#    by a read only shell check, WORKER_BUILD_VERSION not overridden.
#    The container output must show buildVersion ${source.commit}, machine x86_64,
#    user ${RUNTIME_USER}, netInterfaces "lo" plus only down kernel fallback tunnels, nodeProcessCount 0, mmdbCount 0,
#    every required asset true, and these critical file hashes:
${source.criticalFiles.map((file) => `#      ${file.sha256}  ${file.imagePath}`).join("\n")}
docker pull --platform=${PLATFORM} "$IMAGE"
{ printf '{"image":"%s","imageInspect":' "$IMAGE"
  docker image inspect "$IMAGE"
  printf ',"container":'
  docker run --rm --pull=never --platform=${PLATFORM} --network=none \\
    --cap-drop=ALL --security-opt=no-new-privileges \\
    --entrypoint /bin/sh "$IMAGE" -c '${script}'
  printf '}\\n'
} > ${shellDouble(targets.inspectJson ?? inspectJson)}
`,
    bundle: `# 6. Build the attestation bundle. Must exit 0; any mismatch is refused.
node scripts/ovd527-build-packet.mjs bundle \\
  --build-json ${shellDouble(buildJson)} \\
  --inspect-json ${shellDouble(inspectJson)} > ${shellDouble(bundleJson)}
`,
    plan: `# 7. Confirm the release runner accepts it. Must print "plan-valid".
node scripts/run-ovd419-final-digest-release.mjs --plan-stdin < ${shellDouble(bundleJson)}
`,
  };
}

export function renderCommands(source, packetDir) {
  const { imageRepository } = OVD419_DIGEST_CONTRACT;
  return `# OVD-527 build qualification commands for ${source.commit}
# Packet: ${packetDir}
# Source archive SHA-256:  ${source.archiveSha256}
# Source manifest SHA-256: ${source.manifestSha256}
# Image tag: ${imageRepository}:${imageTag(source)}
# This is a build only Cloud Build: one docker build step, one pushed image, no deploy.
# Nothing here changes Cloud Run, the database, or any provider.

${Object.values(commandSteps(source, packetDir)).join("\n")}`;
}

/* ------------------------------------------------------------------ */
/* Source                                                               */
/* ------------------------------------------------------------------ */

function defaultGit(cwd) {
  return (args, options = {}) =>
    execFileSync(GIT_BIN, args, {
      cwd,
      maxBuffer: 512 * 1024 * 1024,
      encoding: options.encoding ?? "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveExisting(target) {
  let current = path.resolve(target);
  const rest = [];
  while (!existsSync(current)) {
    rest.unshift(path.basename(current));
    current = path.dirname(current);
  }
  return path.join(realpathSync(current), ...rest);
}

/** Create the source archive, manifest and build configuration for one clean SHA. */
export function createSourcePacket({ sha, cwd = process.cwd(), outDir, git = defaultGit(cwd) }) {
  if (!isFullSha(sha)) throw new PacketError("--sha must be a full 40 character lowercase SHA");
  const root = realpathSync(git(["rev-parse", "--show-toplevel"]).trim());
  const head = git(["rev-parse", "HEAD"]).trim();
  if (head !== sha) throw new PacketError(`checkout HEAD ${head} does not match --sha ${sha}`);
  const status = git(["status", "--porcelain=v1", "--untracked-files=all", "--ignored=no"]);
  if (status.trim() !== "") throw new PacketError("checkout is dirty; commit or remove every change first");

  const packetDir = resolveExisting(outDir ?? defaultPacketDir(sha));
  if (isInside(packetDir, root)) {
    throw new PacketError("packet directory must be outside the repository so the checkout stays clean");
  }

  const tar = git(["archive", "--format=tar", sha, SOURCE_PREFIX], { encoding: "buffer" });
  const { text: manifestText, files } = manifestFromTar(tar, sha);
  const archive = gzipArchive(tar);
  const source = {
    schema: PACKET_SCHEMA,
    commit: sha,
    worktreeClean: true,
    sourcePrefix: `${SOURCE_PREFIX}/`,
    tarSha256: sha256(tar),
    archiveSha256: sha256(archive),
    manifestSha256: sha256(Buffer.from(manifestText, "utf8")),
    manifestEntryCount: files.size,
    criticalFiles: criticalFileHashes(files),
  };

  mkdirSync(packetDir, { recursive: true });
  writeFileSync(path.join(packetDir, "source.tgz"), archive);
  writeFileSync(path.join(packetDir, "source-manifest.txt"), manifestText);
  writeFileSync(path.join(packetDir, "source.json"), stableJson(source));
  writeFileSync(path.join(packetDir, "cloudbuild.json"), stableJson(cloudBuildConfig(source)));
  return { source, packetDir };
}

/** Load a packet and confirm its archive, manifest and config still match source.json. */
export function loadPacket(packetDir) {
  let source;
  try {
    source = JSON.parse(readFileSync(path.join(packetDir, "source.json"), "utf8"));
  } catch {
    throw new PacketError(`cannot read ${path.join(packetDir, "source.json")}; run the source step first`);
  }
  if (source?.schema !== PACKET_SCHEMA || !isFullSha(source.commit) || source.worktreeClean !== true) {
    throw new PacketError("source.json is not a clean ovd527 source record");
  }
  const archive = readFileSync(path.join(packetDir, "source.tgz"));
  const manifestText = readFileSync(path.join(packetDir, "source-manifest.txt"), "utf8");
  const failures = [];
  if (sha256(archive) !== source.archiveSha256) failures.push("source_archive_changed");
  if (sha256(Buffer.from(manifestText, "utf8")) !== source.manifestSha256) {
    failures.push("source_manifest_changed");
  }
  let derived;
  try {
    derived = manifestFromTar(gunzipSync(archive), source.commit);
  } catch {
    failures.push("source_archive_unreadable");
  }
  if (derived) {
    if (derived.text !== manifestText) failures.push("source_manifest_not_derived_from_archive");
    try {
      if (JSON.stringify(criticalFileHashes(derived.files)) !== JSON.stringify(source.criticalFiles)) {
        failures.push("source_critical_files_changed");
      }
    } catch {
      failures.push("source_critical_files_changed");
    }
  }
  const configPath = path.join(packetDir, "cloudbuild.json");
  if (!existsSync(configPath) || readFileSync(configPath, "utf8") !== stableJson(cloudBuildConfig(source))) {
    failures.push("cloudbuild_config_changed");
  }
  if (failures.length > 0) throw new PacketError("packet files do not match source.json", failures);
  return source;
}

/* ------------------------------------------------------------------ */
/* Bundle                                                               */
/* ------------------------------------------------------------------ */

function lastSegment(value) {
  return typeof value === "string" ? value.split("/").pop() : undefined;
}

function sameStep(step, expected) {
  return (
    step?.name === expected.name &&
    (step.dir ?? "") === expected.dir &&
    Array.isArray(step.args) &&
    JSON.stringify(step.args) === JSON.stringify(expected.args)
  );
}

function provenanceArchiveSha256(build) {
  const fileHashes = build?.sourceProvenance?.fileHashes;
  if (!fileHashes || typeof fileHashes !== "object") return null;
  const entries = Object.values(fileHashes);
  if (entries.length !== 1) return null;
  const hashes = (entries[0]?.fileHash ?? []).filter((hash) => hash?.type === "SHA256");
  if (hashes.length !== 1 || typeof hashes[0].value !== "string") return null;
  const hex = Buffer.from(hashes[0].value, "base64").toString("hex");
  return HASH_PATTERN.test(hex) ? hex : null;
}

function tagValue(build, prefix) {
  const matches = (build?.tags ?? []).filter((tag) => typeof tag === "string" && tag.startsWith(prefix));
  return matches.length === 1 ? matches[0].slice(prefix.length) : null;
}

function buildArgVersion(step) {
  const args = Array.isArray(step?.args) ? step.args : [];
  const values = args
    .filter((arg) => typeof arg === "string" && arg.startsWith("WORKER_BUILD_VERSION="))
    .map((arg) => arg.slice("WORKER_BUILD_VERSION=".length));
  return values.length === 1 ? values[0] : null;
}

/** Turn saved gcloud and docker outputs into the attestBuildOnly bundle. */
export function assembleBundle({ source, buildOutput, inspectOutput }) {
  const failures = [];
  const expect = (condition, code) => {
    if (!condition) failures.push(code);
  };
  const { imageRepository } = OVD419_DIGEST_CONTRACT;
  const tag = imageTag(source);
  const expectedStep = expectedBuildStep(source);

  const build = buildOutput?.build;
  const steps = Array.isArray(build?.steps) ? build.steps : [];
  expect(steps.length === 1 && sameStep(steps[0], expectedStep), "build_steps_not_exact");
  expect(
    JSON.stringify(build?.images ?? []) === JSON.stringify([taggedImage(source)]),
    "build_images_not_exact",
  );
  for (const expectedTag of buildTags(source)) {
    expect((build?.tags ?? []).includes(expectedTag), "build_tags_missing");
  }

  const tagCommit = tagValue(build, "ovd527-commit-");
  const argCommit = buildArgVersion(steps[0]);
  const sourceCommit = tagCommit !== null && tagCommit === argCommit ? tagCommit : null;
  expect(sourceCommit === source.commit, "build_commit_mismatch");

  const provenance = provenanceArchiveSha256(build);
  const tagArchive = tagValue(build, "ovd527-archive-");
  const sourceArchiveSha256 = provenance !== null && provenance === tagArchive ? provenance : null;
  expect(sourceArchiveSha256 === source.archiveSha256, "build_archive_mismatch");
  const sourceManifestSha256 = tagValue(build, "ovd527-manifest-");
  expect(sourceManifestSha256 === source.manifestSha256, "build_manifest_mismatch");

  const results = (build?.results?.images ?? []).filter((image) => image?.name === taggedImage(source));
  const builtDigest = results.length === 1 && DIGEST_PATTERN.test(results[0].digest ?? "")
    ? results[0].digest : null;
  expect(builtDigest !== null, "build_result_digest_missing");
  const exactImage = builtDigest ? `${imageRepository}@${builtDigest}` : null;

  const tagEntries = (Array.isArray(buildOutput?.tags) ? buildOutput.tags : []).filter(
    (entry) => lastSegment(entry?.tag ?? entry?.name) === tag,
  );
  const tagDigest = tagEntries.length === 1
    ? lastSegment(tagEntries[0]?.version ?? tagEntries[0]?.digest) : null;
  const resolveDigest = buildOutput?.resolve?.image_summary?.digest;
  const tagResolvedManifestDigest =
    DIGEST_PATTERN.test(resolveDigest ?? "") && resolveDigest === tagDigest ? resolveDigest : null;
  expect(tagResolvedManifestDigest !== null && tagResolvedManifestDigest === builtDigest, "registry_digest_mismatch");
  expect(build?.status === "SUCCESS", "build_not_successful");

  const imageInspect = Array.isArray(inspectOutput?.imageInspect) && inspectOutput.imageInspect.length === 1
    ? inspectOutput.imageInspect[0] : null;
  const container = inspectOutput?.container;
  expect(imageInspect !== null, "image_inspect_missing");
  expect(container?.schema === "ovd527-container-v1", "container_output_missing");

  const inspectedImage = inspectOutput?.image;
  const repoDigests = Array.isArray(imageInspect?.RepoDigests) ? imageInspect.RepoDigests : [];
  const runtimeImage = typeof inspectedImage === "string" && repoDigests.includes(inspectedImage)
    ? inspectedImage : null;
  expect(runtimeImage !== null && runtimeImage === exactImage, "runtime_image_mismatch");

  const env = Array.isArray(imageInspect?.Config?.Env) ? imageInspect.Config.Env : [];
  const envVersions = env
    .filter((entry) => typeof entry === "string" && entry.startsWith("WORKER_BUILD_VERSION="))
    .map((entry) => entry.slice("WORKER_BUILD_VERSION=".length));
  const buildVersion = envVersions.length === 1 && envVersions[0] === container?.buildVersion
    ? container.buildVersion : null;
  expect(buildVersion === source.commit, "runtime_build_version_mismatch");

  const imagePlatform = `${imageInspect?.Os}/${imageInspect?.Architecture}`;
  const platform = imagePlatform === PLATFORM && container?.machine === "x86_64"
    ? PLATFORM : `${imagePlatform} (${container?.machine})`;
  expect(platform === PLATFORM, "runtime_platform_mismatch");

  const interfaces = typeof container?.netInterfaces === "string"
    ? container.netInterfaces.trim().split(/\s+/).filter(Boolean) : [];
  const network = runtimeNetworkDisabled(interfaces) ? "none" : "present";
  expect(network === "none", "runtime_network_present");

  const workerEntrypointStarted = container?.nodeProcessCount !== 0;
  expect(!workerEntrypointStarted, "runtime_worker_started");
  expect(container?.user === RUNTIME_USER, "runtime_user_mismatch");

  const assets = container?.assets ?? {};
  const requiredRuntimeAssetsPresent =
    REQUIRED_RUNTIME_ASSETS.every(({ path: assetPath }) => assets[assetPath] === true) &&
    container?.mmdbCount === 0;
  expect(requiredRuntimeAssetsPresent, "runtime_assets_missing");

  const observed = container?.criticalFiles ?? {};
  const criticalFileHashesMatched = source.criticalFiles.every(
    ({ imagePath, sha256: expected }) => observed[imagePath] === expected,
  );
  expect(criticalFileHashesMatched, "runtime_hashes_mismatch");

  const commit = source.commit;
  const bundle = {
    record: {
      contractId: OVD419_DIGEST_CONTRACT.contractId,
      schemaVersion: OVD419_DIGEST_CONTRACT.schemaVersion,
      commit,
      image: exactImage,
      worktreeClean: source.worktreeClean,
      buildVersion: commit,
    },
    buildEvidence: {
      source: {
        commit,
        worktreeClean: source.worktreeClean,
        archiveSha256: source.archiveSha256,
        manifestSha256: source.manifestSha256,
      },
      build: {
        id: build?.id ?? null,
        status: build?.status ?? null,
        sourceCommit,
        sourceArchiveSha256,
        sourceManifestSha256,
        exactImage,
        tagEntryCount: tagEntries.length,
        tagResolvedManifestDigest,
        deployStepCount: steps.filter((step) => !sameStep(step, expectedStep)).length,
      },
      runtime: {
        image: runtimeImage,
        buildVersion,
        platform,
        network,
        workerEntrypointStarted,
        requiredRuntimeAssetsPresent,
        criticalFileHashesMatched,
      },
    },
  };

  try {
    attestBuildOnly(JSON.stringify(bundle.record), bundle.buildEvidence);
  } catch {
    failures.push("attest_build_only_rejected");
  }
  if (failures.length > 0) {
    throw new PacketError("build evidence does not qualify", [...new Set(failures)]);
  }
  return bundle;
}

/* ------------------------------------------------------------------ */
/* CLI                                                                  */
/* ------------------------------------------------------------------ */

const USAGE = `usage:
  node scripts/ovd527-build-packet.mjs source   --sha <full sha> [--out <dir>]
  node scripts/ovd527-build-packet.mjs commands --sha <full sha> [--out <dir>]
  node scripts/ovd527-build-packet.mjs bundle   --build-json <file> --inspect-json <file> [--packet-dir <dir>]
The packet directory defaults to ~/ovd527-packet/<sha> and must be outside the repository.
`;

export function parseFlags(args, allowed) {
  const flags = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!allowed.includes(name) || value === undefined || value.startsWith("--") || name in flags) {
      throw new PacketError(`unexpected argument ${name ?? ""}`.trim());
    }
    flags[name] = value;
  }
  return flags;
}

export function readJsonFile(file, label) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new PacketError(`${label} is not readable JSON: ${file}`);
  }
}

export function runCli({
  args = process.argv.slice(2),
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
  git,
} = {}) {
  const [command, ...rest] = args;
  try {
    if (command === "source") {
      const flags = parseFlags(rest, ["--sha", "--out"]);
      if (!flags["--sha"]) throw new PacketError("--sha is required");
      const { source, packetDir } = createSourcePacket({
        sha: flags["--sha"],
        cwd,
        outDir: flags["--out"],
        git,
      });
      stdout.write(
        [
          `commit            ${source.commit}`,
          `packet            ${packetDir}`,
          `archive sha256    ${source.archiveSha256}  source.tgz`,
          `manifest sha256   ${source.manifestSha256}  source-manifest.txt`,
          `manifest entries  ${source.manifestEntryCount}`,
          "critical files (image path, expected sha256):",
          ...source.criticalFiles.map((file) => `  ${file.sha256}  ${file.imagePath}  <- ${file.sourcePath}`),
          "",
        ].join("\n"),
      );
      return 0;
    }
    if (command === "commands") {
      const flags = parseFlags(rest, ["--sha", "--out"]);
      if (!isFullSha(flags["--sha"])) throw new PacketError("--sha must be a full 40 character lowercase SHA");
      const packetDir = path.resolve(flags["--out"] ?? defaultPacketDir(flags["--sha"]));
      const source = loadPacket(packetDir);
      if (source.commit !== flags["--sha"]) throw new PacketError("packet commit does not match --sha");
      stdout.write(renderCommands(source, packetDir));
      return 0;
    }
    if (command === "bundle") {
      const flags = parseFlags(rest, ["--build-json", "--inspect-json", "--packet-dir"]);
      if (!flags["--build-json"] || !flags["--inspect-json"]) {
        throw new PacketError("--build-json and --inspect-json are required");
      }
      const buildFile = path.resolve(cwd, flags["--build-json"]);
      const packetDir = path.resolve(cwd, flags["--packet-dir"] ?? path.dirname(buildFile));
      const source = loadPacket(packetDir);
      const bundle = assembleBundle({
        source,
        buildOutput: readJsonFile(buildFile, "--build-json"),
        inspectOutput: readJsonFile(path.resolve(cwd, flags["--inspect-json"]), "--inspect-json"),
      });
      stdout.write(stableJson(bundle));
      return 0;
    }
    stderr.write(USAGE);
    return 2;
  } catch (error) {
    if (!(error instanceof PacketError)) throw error;
    stderr.write(`ovd527 refused: ${error.message}\n`);
    for (const failure of error.failures) stderr.write(`  - ${failure}\n`);
    return 1;
  }
}

if (isDirectCli(import.meta.url)) process.exitCode = runCli();
