import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { attestBuildOnly } from "./run-ovd419-final-digest-release.mjs";
import { assembleBundle, loadPacket, stableJson } from "./ovd527-build-packet.mjs";
import { BUILD_SCRIPT, INSPECT_SCRIPT, NEEDS_GCP, parsePlanVerdict, runCli } from "./ovd527-qualify-candidate.mjs";
import {
  DIGEST,
  git,
  goodBuildOutput,
  goodInspectOutput,
  makeRepo,
  removeTempDirs,
  tempDir,
  writeRepoFile,
} from "./ovd527-test-fixtures.mjs";

afterEach(removeTempDirs);
const SLOW = 120_000; // each case spawns git, bash and node many times
/** Every call the two GCP scripts may make; anything else (a deploy, an update) fails. */
const ALLOWED_CALL = new RegExp(
  "^(gcloud builds (submit|log|describe) |gcloud artifacts docker (images describe|tags list) |" +
    "docker (info$|pull --platform=linux/amd64 |image inspect |run --rm --pull=never --platform=linux/amd64 --network=none ))",
);

function qualify(root, sha, worktree, out) {
  let stdout = "";
  let stderr = "";
  const code = runCli({
    args: ["--sha", sha, "--worktree", worktree, "--out", out],
    cwd: root,
    stdout: { write: (chunk) => (stdout += chunk) },
    stderr: { write: (chunk) => (stderr += chunk) },
  });
  return { code, stdout, stderr };
}

function setup({ releaseRunner = true } = {}) {
  const { root, sha } = makeRepo({ releaseRunner });
  const worktree = path.join(tempDir("wt"), "candidate");
  const out = path.join(tempDir("out"), "packet");
  return { root, sha, worktree, out };
}

/** Fake gcloud and docker that answer from synthetic outputs and log every call. */
function fakeTools(source) {
  const dir = tempDir("fake");
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  const build = goodBuildOutput(source);
  const inspect = goodInspectOutput(source);
  for (const [name, value] of Object.entries({
    "build.json": build.build, "resolve.json": build.resolve, "tags.json": build.tags,
    "image-inspect.json": inspect.imageInspect, "container.json": inspect.container,
  })) writeFileSync(path.join(dir, name), JSON.stringify(value));
  writeFileSync(path.join(bin, "gcloud"), `#!/bin/sh
printf 'gcloud %s\\n' "$*" >> "$FAKE_DIR/calls.log"
case "$1 $2 $3 $4" in
  "builds submit"*) echo "${build.build.id}" ;;
  "builds log"*) echo "synthetic log" ;;
  "builds describe"*) cat "$FAKE_DIR/build.json" ;;
  "artifacts docker images describe") case "$*" in *value*) echo "${DIGEST}" ;; *) cat "$FAKE_DIR/resolve.json" ;; esac ;;
  "artifacts docker tags list") cat "$FAKE_DIR/tags.json" ;;
  *) exit 9 ;;
esac
`);
  writeFileSync(path.join(bin, "docker"), `#!/bin/sh
printf 'docker %s\\n' "$*" >> "$FAKE_DIR/calls.log"
case "$1" in
  info) exit "\${FAKE_DOCKER_INFO_EXIT:-0}" ;;
  pull) echo pulled ;;
  image) cat "$FAKE_DIR/image-inspect.json" ;;
  run) cat "$FAKE_DIR/container.json" ;;
  *) exit 9 ;;
esac
`);
  chmodSync(path.join(bin, "gcloud"), 0o755);
  chmodSync(path.join(bin, "docker"), 0o755);
  const calls = () => (existsSync(path.join(dir, "calls.log")) ? readFileSync(path.join(dir, "calls.log"), "utf8") : "");
  const runScript = (script, extraEnv = {}) =>
    spawnSync("/bin/bash", [script], {
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, FAKE_DIR: dir, ...extraEnv },
    });
  return { calls, runScript };
}

describe("ovd527 qualify-candidate", () => {
  it("goes from a SHA to a plan-valid bundle through the two GCP scripts, never submitting twice", () => {
    const { root, sha, worktree, out } = setup();
    const first = qualify(root, sha, worktree, out);
    expect(first.code).toBe(NEEDS_GCP);
    expect(git(worktree, "rev-parse", "HEAD").trim()).toBe(sha);
    expect(first.stdout).toContain("this tool runs neither gcloud nor docker");
    expect(first.stdout).toContain(`----- ${BUILD_SCRIPT} -----`);
    expect(first.stdout).toContain(`----- ${INSPECT_SCRIPT} -----`);
    expect(first.stdout).toContain("gcloud builds submit");
    expect(first.stdout).not.toMatch(/gcloud run|deploy-cloud-run|--set-env-vars/);

    const packetDir = realpathSync(out);
    const source = loadPacket(packetDir);
    const buildScript = path.join(packetDir, BUILD_SCRIPT);
    const inspectScript = path.join(packetDir, INSPECT_SCRIPT);
    const { calls, runScript } = fakeTools(source);

    expect(runScript(inspectScript).stdout).toContain(`Run bash "${buildScript}" first.`);
    expect(runScript(buildScript).status).toBe(0);
    expect(existsSync(path.join(packetDir, "build.json.partial"))).toBe(false);
    expect(readFileSync(path.join(packetDir, "build-id.txt"), "utf8").trim()).toBe(goodBuildOutput(source).build.id);

    const second = qualify(root, sha, worktree, out);
    expect(second.code).toBe(NEEDS_GCP);
    expect(second.stdout).not.toContain(`----- ${BUILD_SCRIPT} -----`);
    expect(second.stdout).toContain(`----- ${INSPECT_SCRIPT} -----`);

    const rerun = runScript(buildScript);
    expect(rerun.status).toBe(0);
    expect(rerun.stdout).toContain("not submitting another");
    expect(calls().match(/^gcloud builds submit /gm)).toHaveLength(1);

    const noDocker = runScript(inspectScript, { FAKE_DOCKER_INFO_EXIT: "1" });
    expect(noDocker.status).not.toBe(0);
    expect(noDocker.stdout).toContain("Start Docker");
    expect(existsSync(path.join(packetDir, "inspect.json"))).toBe(false);
    expect(runScript(inspectScript).status).toBe(0);
    for (const call of calls().trim().split("\n")) expect(call).toMatch(ALLOWED_CALL);

    const done = qualify(root, sha, worktree, out);
    expect(done.stderr).toBe("");
    expect(done.code).toBe(0);
    expect(done.stdout).toContain("plan-valid");
    expect(done.stdout).toContain(`SHA=${sha} DIGEST=${DIGEST}`);
    const bundleText = readFileSync(path.join(packetDir, "bundle.json"), "utf8");
    const expected = assembleBundle({
      source, buildOutput: goodBuildOutput(source), inspectOutput: goodInspectOutput(source),
    });
    expect(bundleText).toBe(stableJson(expected));
    expect(attestBuildOnly(JSON.stringify(expected.record), expected.buildEvidence).verdict).toBe("build-attested");

    expect(qualify(root, sha, worktree, out).code).toBe(0);
    writeFileSync(path.join(packetDir, "bundle.json"), bundleText.replace("SUCCESS", "FAILURE"));
    const swapped = qualify(root, sha, worktree, out);
    expect(swapped.code).toBe(1);
    expect(swapped.stderr).toMatch(/bundle\.json differs/);
  }, SLOW);

  it("refuses bad input, unmerged commits and a dirty worktree", () => {
    const { root, sha, worktree, out } = setup({ releaseRunner: false });
    expect(runCli({ args: [], stdout: { write() {} }, stderr: { write() {} } })).toBe(2);
    expect(qualify(root, sha.slice(0, 12), worktree, out).stderr).toMatch(/full 40 character/);

    writeRepoFile(root, "worker/src/index.ts", "console.log('unmerged');\n");
    git(root, "commit", "-q", "-am", "unmerged");
    const unmerged = qualify(root, git(root, "rev-parse", "HEAD").trim(), worktree, out);
    expect(unmerged.code).toBe(1);
    expect(unmerged.stderr).toMatch(/not on origin\/main/);
    expect(existsSync(worktree)).toBe(false);
    expect(qualify(root, sha, path.join(root, "worker"), out).stderr).toMatch(/not a checkout's top level/);

    expect(qualify(root, sha, worktree, out).code).toBe(NEEDS_GCP);
    writeFileSync(path.join(worktree, "stray.txt"), "x");
    const dirty = qualify(root, sha, worktree, out);
    expect(dirty.code).toBe(1);
    expect(dirty.stderr).toMatch(/is dirty/);
  }, SLOW);

  it("writes no bundle for failing evidence or when the candidate runner cannot confirm it", () => {
    const { root, sha } = makeRepo({
      extraFiles: {
        "scripts/run-ovd419-final-digest-release.mjs":
          'process.stdout.write("OVD-419 plan rejected; failing closed.\\n");\nprocess.exitCode = 1;\n',
      },
    });
    const worktree = path.join(tempDir("wt"), "candidate");
    const out = path.join(tempDir("out"), "packet");
    expect(qualify(root, sha, worktree, out).code).toBe(NEEDS_GCP);
    const packetDir = realpathSync(out);
    const source = loadPacket(packetDir);
    const inspect = goodInspectOutput(source);
    inspect.container.user = "root";
    writeFileSync(path.join(packetDir, "build.json"), JSON.stringify(goodBuildOutput(source)));
    writeFileSync(path.join(packetDir, "inspect.json"), JSON.stringify(inspect));
    const refused = qualify(root, sha, worktree, out);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("runtime_user_mismatch");
    expect(refused.stderr).toContain("Delete the bad build.json or inspect.json");

    writeFileSync(path.join(packetDir, "inspect.json"), JSON.stringify(goodInspectOutput(source)));
    const rejected = qualify(root, sha, worktree, out);
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain("did not accept the bundle: OVD-419 plan rejected; failing closed.");
    expect(existsSync(path.join(packetDir, "bundle.json"))).toBe(false);
  }, SLOW);

  it("accepts only a plan-valid verdict from the release runner", () => {
    expect(parsePlanVerdict('{"verdict":"plan-valid","probes":{}}\n').verdict).toBe("plan-valid");
    for (const text of ["OVD-419 plan rejected; failing closed.\n", '{"verdict":"plan-invalid"}', ""]) {
      expect(() => parsePlanVerdict(text)).toThrow(/did not report plan-valid/);
    }
  });
});
