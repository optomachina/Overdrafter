import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OVD419_DIGEST_CONTRACT as CONTRACT } from "./ovd419-digest-contract.mjs";
import {
  attestBuildOnly,
  runCli as runReleaseCli,
} from "./run-ovd419-final-digest-release.mjs";
import {
  PacketError,
  REQUIRED_RUNTIME_ASSETS,
  assembleBundle,
  buildTags,
  cloudBuildConfig,
  containerInspectionScript,
  createSourcePacket,
  expectedBuildStep,
  imageTag,
  loadPacket,
  renderCommands,
  runCli,
  taggedImage,
} from "./ovd527-build-packet.mjs";

const DIGEST = `sha256:${"d".repeat(64)}`;
const IMAGE = `${CONTRACT.imageRepository}@${DIGEST}`;
const DOCKERFILE = `FROM scratch
RUN mkdir -p /home/pwuser/.cache/camoufox \\
  && printf '%s' '{"version":"152.0.4","release":"beta.28"}' > /home/pwuser/.cache/camoufox/version.json
`;

const tempDirs = [];
function tempDir(label) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `ovd527-${label}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function writeRepoFile(root, relative, content) {
  mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  writeFileSync(path.join(root, relative), content);
}

function makeRepo() {
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
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "fixture");
  return { root, sha: git(root, "rev-parse", "HEAD").trim() };
}

function makePacket() {
  const repo = makeRepo();
  const outDir = path.join(tempDir("packet"), "packet");
  const { source, packetDir } = createSourcePacket({ sha: repo.sha, cwd: repo.root, outDir });
  return { ...repo, source, packetDir };
}

function goodBuildOutput(source) {
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

function goodInspectOutput(source) {
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

function captureRefusal(fn) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PacketError);
    return error;
  }
  throw new Error("expected refusal");
}

describe("ovd527 source", () => {
  it("creates a deterministic archive and manifest for a clean matching checkout", () => {
    const { root, sha, source, packetDir } = makePacket();
    expect(source.commit).toBe(sha);
    expect(source.worktreeClean).toBe(true);
    expect(source.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(source.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(source.manifestEntryCount).toBe(5);
    const manifest = readFileSync(path.join(packetDir, "source-manifest.txt"), "utf8");
    expect(manifest).toContain(`commit ${sha}`);
    expect(manifest).toContain("worker/src/index.ts");
    expect(manifest).not.toContain("README.md");
    expect(source.criticalFiles.map((f) => f.imagePath)).toEqual([
      "/app/package.json",
      "/app/package-lock.json",
      "/app/scripts/install-camoufox.mjs",
      "/home/pwuser/.cache/camoufox/version.json",
    ]);

    const again = createSourcePacket({ sha, cwd: root, outDir: path.join(tempDir("again"), "p") });
    expect(again.source).toEqual(source);
    expect(loadPacket(packetDir)).toEqual(source);
  });

  it("refuses a dirty checkout, including untracked files", () => {
    const { root, sha } = makeRepo();
    writeFileSync(path.join(root, "stray.txt"), "x");
    const error = captureRefusal(() =>
      createSourcePacket({ sha, cwd: root, outDir: path.join(tempDir("o"), "p") }),
    );
    expect(error.message).toMatch(/dirty/);
  });

  it("refuses a SHA that is not the checked out HEAD", () => {
    const { root } = makeRepo();
    const error = captureRefusal(() =>
      createSourcePacket({ sha: "a".repeat(40), cwd: root, outDir: path.join(tempDir("o"), "p") }),
    );
    expect(error.message).toMatch(/does not match/);
  });

  it("refuses short or uppercase SHAs", () => {
    const { root, sha } = makeRepo();
    for (const bad of [sha.slice(0, 12), sha.toUpperCase()]) {
      captureRefusal(() => createSourcePacket({ sha: bad, cwd: root, outDir: tempDir("o") }));
    }
  });

  it("refuses a packet directory inside the repository", () => {
    const { root, sha } = makeRepo();
    const error = captureRefusal(() =>
      createSourcePacket({ sha, cwd: root, outDir: path.join(root, "packet") }),
    );
    expect(error.message).toMatch(/outside the repository/);
  });

  it("refuses when the Dockerfile no longer pins the Camoufox version literal", () => {
    const { root } = makeRepo();
    writeRepoFile(root, "worker/Dockerfile", "FROM scratch\n");
    git(root, "commit", "-q", "-am", "drop pin");
    const sha = git(root, "rev-parse", "HEAD").trim();
    const error = captureRefusal(() =>
      createSourcePacket({ sha, cwd: root, outDir: path.join(tempDir("o"), "p") }),
    );
    expect(error.message).toMatch(/version\.json/);
  });

  it("detects packet files changed after the source step", () => {
    for (const [file, failure] of [
      ["source.tgz", "source_archive_changed"],
      ["source-manifest.txt", "source_manifest_changed"],
      ["cloudbuild.json", "cloudbuild_config_changed"],
    ]) {
      const { packetDir } = makePacket();
      writeFileSync(path.join(packetDir, file), `${readFileSync(path.join(packetDir, file), "utf8")} `);
      const error = captureRefusal(() => loadPacket(packetDir));
      expect(error.failures).toContain(failure);
    }
  });
});

describe("ovd527 commands", () => {
  it("prints a build only submission, digest resolve and offline inspection for the SHA", () => {
    const { source, packetDir } = makePacket();
    const text = renderCommands(source, packetDir);
    expect(text).toContain("gcloud builds submit");
    expect(text).toContain(`--project=${CONTRACT.project} --region=${CONTRACT.region}`);
    expect(text).toContain("gcloud artifacts docker images describe");
    expect(text).toContain("gcloud artifacts docker tags list");
    expect(text).toContain("--platform=linux/amd64 --network=none");
    expect(text).toContain(`buildVersion ${source.commit}`);
    expect(text).not.toMatch(/gcloud run|deploy-cloud-run|--set-env-vars/);
    expect(text).not.toMatch(/-e WORKER_BUILD_VERSION|--env/);

    const config = cloudBuildConfig(source);
    expect(config.steps).toHaveLength(1);
    expect(config.steps[0].args).toContain(`WORKER_BUILD_VERSION=${source.commit}`);
    expect(config.steps[0].args).toContain("--platform=linux/amd64");
    expect(config.images).toEqual([taggedImage(source)]);
    expect(config.options.sourceProvenanceHash).toEqual(["SHA256"]);
  });

  it("emits an inspection script that prints parseable JSON without single quotes", () => {
    const { source } = makePacket();
    const script = containerInspectionScript(source);
    expect(script).not.toContain("'");
    const output = execFileSync("/bin/sh", ["-c", script], {
      encoding: "utf8",
      env: { ...process.env, WORKER_BUILD_VERSION: source.commit },
    });
    const parsed = JSON.parse(output);
    expect(parsed.schema).toBe("ovd527-container-v1");
    expect(parsed.buildVersion).toBe(source.commit);
    expect(Object.keys(parsed.criticalFiles)).toEqual(source.criticalFiles.map((f) => f.imagePath));
    expect(Object.keys(parsed.assets)).toEqual(REQUIRED_RUNTIME_ASSETS.map((a) => a.path));
    expect(Number.isInteger(parsed.nodeProcessCount)).toBe(true);
  });

  it("runs through the CLI against an existing packet", () => {
    const { sha, packetDir } = makePacket();
    let out = "";
    const code = runCli({
      args: ["commands", "--sha", sha, "--out", packetDir],
      stdout: { write: (chunk) => (out += chunk) },
      stderr: { write: () => {} },
    });
    expect(code).toBe(0);
    expect(out).toContain(`WORKER_BUILD_VERSION=${sha}`);
  });
});

describe("ovd527 bundle", () => {
  it("emits a bundle that attestBuildOnly and the release plan accept", async () => {
    const { source } = makePacket();
    const bundle = assembleBundle({
      source,
      buildOutput: goodBuildOutput(source),
      inspectOutput: goodInspectOutput(source),
    });
    expect(bundle.record.image).toBe(IMAGE);
    const verdict = attestBuildOnly(JSON.stringify(bundle.record), bundle.buildEvidence);
    expect(verdict.verdict).toBe("build-attested");
    expect(verdict.sourceArchiveSha256).toBe(source.archiveSha256);

    let out = "";
    const code = await runReleaseCli({
      args: ["--plan-stdin"],
      input: () => JSON.stringify(bundle),
      output: { write: (chunk) => (out += chunk) },
    });
    expect(code).toBe(0);
    expect(JSON.parse(out).verdict).toBe("plan-valid");
  });

  const TAMPERS = {
    "record.commit": (b) => (b.record.commit = "a".repeat(40)),
    "record.image": (b) => (b.record.image = `${CONTRACT.imageRepository}@sha256:${"0".repeat(64)}`),
    "record.worktreeClean": (b) => (b.record.worktreeClean = false),
    "record.buildVersion": (b) => (b.record.buildVersion = "unknown"),
    "source.commit": (b) => (b.buildEvidence.source.commit = "a".repeat(40)),
    "source.worktreeClean": (b) => (b.buildEvidence.source.worktreeClean = false),
    "source.archiveSha256": (b) => (b.buildEvidence.source.archiveSha256 = "short"),
    "source.manifestSha256": (b) => (b.buildEvidence.source.manifestSha256 = "short"),
    "build.id": (b) => (b.buildEvidence.build.id = "bad id!"),
    "build.status": (b) => (b.buildEvidence.build.status = "FAILURE"),
    "build.sourceCommit": (b) => (b.buildEvidence.build.sourceCommit = "a".repeat(40)),
    "build.sourceArchiveSha256": (b) => (b.buildEvidence.build.sourceArchiveSha256 = "0".repeat(64)),
    "build.sourceManifestSha256": (b) => (b.buildEvidence.build.sourceManifestSha256 = "0".repeat(64)),
    "build.exactImage": (b) => (b.buildEvidence.build.exactImage = `${CONTRACT.imageRepository}@sha256:${"0".repeat(64)}`),
    "build.tagEntryCount": (b) => (b.buildEvidence.build.tagEntryCount = 2),
    "build.tagResolvedManifestDigest": (b) => (b.buildEvidence.build.tagResolvedManifestDigest = `sha256:${"0".repeat(64)}`),
    "build.deployStepCount": (b) => (b.buildEvidence.build.deployStepCount = 1),
    "runtime.image": (b) => (b.buildEvidence.runtime.image = `${CONTRACT.imageRepository}@sha256:${"0".repeat(64)}`),
    "runtime.buildVersion": (b) => (b.buildEvidence.runtime.buildVersion = "unknown"),
    "runtime.platform": (b) => (b.buildEvidence.runtime.platform = "linux/arm64"),
    "runtime.network": (b) => (b.buildEvidence.runtime.network = "bridge"),
    "runtime.workerEntrypointStarted": (b) => (b.buildEvidence.runtime.workerEntrypointStarted = true),
    "runtime.requiredRuntimeAssetsPresent": (b) => (b.buildEvidence.runtime.requiredRuntimeAssetsPresent = false),
    "runtime.criticalFileHashesMatched": (b) => (b.buildEvidence.runtime.criticalFileHashesMatched = false),
  };

  it.each(Object.keys(TAMPERS))("attestBuildOnly rejects a tool bundle with tampered %s", (field) => {
    const { source } = makePacket();
    const bundle = structuredClone(
      assembleBundle({ source, buildOutput: goodBuildOutput(source), inspectOutput: goodInspectOutput(source) }),
    );
    TAMPERS[field](bundle);
    expect(() => attestBuildOnly(JSON.stringify(bundle.record), bundle.buildEvidence)).toThrow();
  });

  const RAW_TAMPERS = {
    build_not_successful: (build) => (build.build.status = "FAILURE"),
    build_steps_not_exact: (build) => build.build.steps.push({ name: "gcr.io/google.com/cloudsdktool/cloud-sdk", args: ["gcloud", "run", "deploy"] }),
    build_commit_mismatch: (build) => (build.build.steps[0].args[3] = `WORKER_BUILD_VERSION=${"a".repeat(40)}`),
    build_archive_mismatch: (build) => {
      build.build.sourceProvenance.fileHashes["gs://b/source.tgz#1"].fileHash[0].value =
        Buffer.alloc(32).toString("base64");
    },
    build_manifest_mismatch: (build) => {
      build.build.tags = build.build.tags.map((t) => (t.startsWith("ovd527-manifest-") ? `ovd527-manifest-${"0".repeat(64)}` : t));
    },
    build_images_not_exact: (build) => build.build.images.push(`${CONTRACT.imageRepository}:latest`),
    build_result_digest_missing: (build) => (build.build.results.images = []),
    registry_digest_mismatch: (build) => (build.resolve.image_summary.digest = `sha256:${"0".repeat(64)}`),
  };

  it.each(Object.keys(RAW_TAMPERS))("refuses saved build output that fails %s", (failure) => {
    const { source } = makePacket();
    const buildOutput = goodBuildOutput(source);
    RAW_TAMPERS[failure](buildOutput);
    const error = captureRefusal(() =>
      assembleBundle({ source, buildOutput, inspectOutput: goodInspectOutput(source) }),
    );
    expect(error.failures).toContain(failure);
  });

  it("refuses a tag that resolves to more than one registry entry", () => {
    const { source } = makePacket();
    const buildOutput = goodBuildOutput(source);
    buildOutput.tags.push({ ...buildOutput.tags[0] });
    const error = captureRefusal(() =>
      assembleBundle({ source, buildOutput, inspectOutput: goodInspectOutput(source) }),
    );
    expect(error.failures).toContain("registry_digest_mismatch");
  });

  const INSPECT_TAMPERS = {
    runtime_image_mismatch: (i) => (i.imageInspect[0].RepoDigests = [`${CONTRACT.imageRepository}@sha256:${"0".repeat(64)}`]),
    runtime_build_version_mismatch: (i) => (i.container.buildVersion = "unknown"),
    runtime_platform_mismatch: (i) => (i.imageInspect[0].Architecture = "arm64"),
    runtime_network_present: (i) => (i.container.netInterfaces = "eth0 lo"),
    runtime_worker_started: (i) => (i.container.nodeProcessCount = 1),
    runtime_assets_missing: (i) => (i.container.assets["/home/pwuser/.cache/camoufox/camoufox-bin"] = false),
    runtime_hashes_mismatch: (i) => (i.container.criticalFiles["/app/package-lock.json"] = "missing"),
  };

  it.each(Object.keys(INSPECT_TAMPERS))("refuses saved inspection output that fails %s", (failure) => {
    const { source } = makePacket();
    const inspectOutput = goodInspectOutput(source);
    INSPECT_TAMPERS[failure](inspectOutput);
    const error = captureRefusal(() =>
      assembleBundle({ source, buildOutput: goodBuildOutput(source), inspectOutput }),
    );
    expect(error.failures).toContain(failure);
    expect(error.failures).toContain("attest_build_only_rejected");
  });

  it("refuses an inspection that ran as a user other than the image user", () => {
    const { source } = makePacket();
    const inspectOutput = goodInspectOutput(source);
    inspectOutput.container.user = "root";
    const error = captureRefusal(() =>
      assembleBundle({ source, buildOutput: goodBuildOutput(source), inspectOutput }),
    );
    expect(error.failures).toEqual(["runtime_user_mismatch"]);
  });

  it("refuses any GeoIP database in the image", () => {
    const { source } = makePacket();
    const inspectOutput = goodInspectOutput(source);
    inspectOutput.container.mmdbCount = 1;
    const error = captureRefusal(() =>
      assembleBundle({ source, buildOutput: goodBuildOutput(source), inspectOutput }),
    );
    expect(error.failures).toContain("runtime_assets_missing");
  });

  it("refuses a build-version override that differs from the baked image env", () => {
    const { source } = makePacket();
    const inspectOutput = goodInspectOutput(source);
    inspectOutput.imageInspect[0].Config.Env = ["WORKER_BUILD_VERSION=unknown"];
    const error = captureRefusal(() =>
      assembleBundle({ source, buildOutput: goodBuildOutput(source), inspectOutput }),
    );
    expect(error.failures).toContain("runtime_build_version_mismatch");
  });

  it("writes the bundle through the CLI and refuses tampered files", () => {
    const { source, packetDir } = makePacket();
    const buildFile = path.join(packetDir, "build.json");
    const inspectFile = path.join(packetDir, "inspect.json");
    writeFileSync(buildFile, JSON.stringify(goodBuildOutput(source)));
    writeFileSync(inspectFile, JSON.stringify(goodInspectOutput(source)));
    let out = "";
    const io = { stdout: { write: (c) => (out += c) }, stderr: { write: () => {} } };
    expect(runCli({ args: ["bundle", "--build-json", buildFile, "--inspect-json", inspectFile], ...io })).toBe(0);
    const bundle = JSON.parse(out);
    expect(attestBuildOnly(JSON.stringify(bundle.record), bundle.buildEvidence).verdict).toBe("build-attested");

    const tampered = goodInspectOutput(source);
    tampered.container.netInterfaces = "eth0 lo";
    writeFileSync(inspectFile, JSON.stringify(tampered));
    let err = "";
    out = "";
    expect(
      runCli({
        args: ["bundle", "--build-json", buildFile, "--inspect-json", inspectFile],
        stdout: io.stdout,
        stderr: { write: (c) => (err += c) },
      }),
    ).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("runtime_network_present");
  });

  it("prints usage for unknown subcommands", () => {
    let err = "";
    expect(runCli({ args: ["deploy"], stdout: { write: () => {} }, stderr: { write: (c) => (err += c) } })).toBe(2);
    expect(err).toContain("usage:");
  });
});
