// Synthetic OVD-527 fixtures shared by the build-packet and qualify-candidate tests.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OVD419_DIGEST_CONTRACT as CONTRACT } from "./ovd419-digest-contract.mjs";
import {
  REQUIRED_RUNTIME_ASSETS,
  buildTags,
  createSourcePacket,
  expectedBuildStep,
  imageTag,
  taggedImage,
} from "./ovd527-build-packet.mjs";

export const DIGEST = `sha256:${"d".repeat(64)}`;
export const IMAGE = `${CONTRACT.imageRepository}@${DIGEST}`;
const DOCKERFILE = `FROM scratch
RUN mkdir -p /home/pwuser/.cache/camoufox \\
  && printf '%s' '{"version":"152.0.4","release":"beta.28"}' > /home/pwuser/.cache/camoufox/version.json
`;
const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
/** The plan-only release runner and its local imports, for a fixture candidate checkout. */
const RELEASE_RUNNER_FILES = [
  "scripts/run-ovd419-final-digest-release.mjs",
  "scripts/ovd419-failure-vocabulary.mjs",
  "scripts/ovd419-digest-contract.mjs",
  "scripts/lib/entry-point.mjs",
];

const tempDirs = [];
export function tempDir(label) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `ovd527-${label}-`));
  tempDirs.push(dir);
  return dir;
}

export function removeTempDirs() {
  while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true });
}

export function git(cwd, ...args) {
  return execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function writeRepoFile(root, relative, content) {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  writeFileSync(path.join(root, relative), content);
}

/** A committed fixture repository whose HEAD is also origin/main. */
export function makeRepo({ releaseRunner = false, extraFiles = {} } = {}) {
  const root = tempDir("repo");
  git(root, "init", "-q");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "commit.gpgsign", "false");
  writeRepoFile(root, "worker/Dockerfile", DOCKERFILE);
  writeRepoFile(root, "worker/package.json", '{"name":"worker"}\n');
  writeRepoFile(root, "worker/package-lock.json", '{"lockfileVersion":3}\n');
  writeRepoFile(root, "worker/scripts/install-camoufox.mjs", "export {};\n");
  writeRepoFile(root, "worker/src/index.ts", "console.log('worker');\n");
  writeRepoFile(root, "README.md", "outside the archive\n");
  if (releaseRunner) {
    for (const file of RELEASE_RUNNER_FILES) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      copyFileSync(path.join(SCRIPTS_DIR, "..", file), path.join(root, file));
    }
  }
  for (const [file, content] of Object.entries(extraFiles)) writeRepoFile(root, file, content);
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "fixture");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  return { root, sha: git(root, "rev-parse", "HEAD").trim() };
}

export function makePacket() {
  const repo = makeRepo();
  const outDir = path.join(tempDir("packet"), "packet");
  const { source, packetDir } = createSourcePacket({ sha: repo.sha, cwd: repo.root, outDir });
  return { ...repo, source, packetDir };
}

export function goodBuildOutput(source) {
  return {
    build: {
      id: "0b8f3c1e-1111-4222-8333-944455556666",
      status: "SUCCESS",
      steps: [{ ...expectedBuildStep(source), status: "SUCCESS", id: "0" }],
      images: [taggedImage(source)],
      tags: buildTags(source),
      results: { images: [{ name: taggedImage(source), digest: DIGEST }] },
      source: { storageSource: { bucket: "b", object: "source.tgz", generation: "1" } },
      sourceProvenance: {
        fileHashes: {
          "gs://b/source.tgz#1": {
            fileHash: [{ type: "SHA256", value: Buffer.from(source.archiveSha256, "hex").toString("base64") }],
          },
        },
      },
      options: { sourceProvenanceHash: ["SHA256"] },
    },
    resolve: { image_summary: { digest: DIGEST, fully_qualified_digest: IMAGE } },
    tags: [
      {
        tag: `projects/p/locations/l/repositories/r/packages/overdrafter-cad-worker/tags/${imageTag(source)}`,
        version: `projects/p/locations/l/repositories/r/packages/overdrafter-cad-worker/versions/${DIGEST}`,
      },
      {
        tag: "projects/p/locations/l/repositories/r/packages/overdrafter-cad-worker/tags/older",
        version: `projects/p/locations/l/repositories/r/packages/overdrafter-cad-worker/versions/sha256:${"e".repeat(64)}`,
      },
    ],
  };
}

export function goodInspectOutput(source) {
  return {
    image: IMAGE,
    imageInspect: [
      {
        Id: `sha256:${"f".repeat(64)}`,
        RepoDigests: [IMAGE],
        Os: "linux",
        Architecture: "amd64",
        Config: {
          Env: ["PATH=/usr/bin", `WORKER_BUILD_VERSION=${source.commit}`],
          Cmd: ["node", "dist/index.js"],
        },
      },
    ],
    container: {
      schema: "ovd527-container-v1",
      buildVersion: source.commit,
      machine: "x86_64",
      user: "pwuser",
      netInterfaces: "lo ",
      nodeProcessCount: 0,
      mmdbCount: 0,
      criticalFiles: Object.fromEntries(source.criticalFiles.map((f) => [f.imagePath, f.sha256])),
      assets: Object.fromEntries(REQUIRED_RUNTIME_ASSETS.map((a) => [a.path, true])),
    },
  };
}
