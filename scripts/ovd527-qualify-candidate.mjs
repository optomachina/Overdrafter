#!/usr/bin/env node
/**
 * OVD-527 build qualification for one candidate SHA, as a single command:
 *
 *   node scripts/ovd527-qualify-candidate.mjs --sha <full sha> [--worktree <dir>] [--out <dir>]
 *
 * Run it, run the GCP script it names, run it again. Each run resumes from the
 * packet: a clean detached worktree at the SHA (created from origin/main
 * history if absent), the source packet, two GCP scripts it prints but never
 * runs, and once their outputs exist the bundle, written only after the
 * candidate's own release runner reports plan-valid.
 * Exit codes: 0 plan-valid, 3 a GCP script must run next, 1 refused, 2 usage.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OVD419_DIGEST_CONTRACT, isDirectCli, isFullSha } from "./ovd419-digest-contract.mjs";
import {
  PacketError,
  assembleBundle,
  commandSteps,
  createSourcePacket,
  defaultPacketDir,
  loadPacket,
  parseFlags,
  readJsonFile,
  shellDouble as quote,
  stableJson,
} from "./ovd527-build-packet.mjs";

export const NEEDS_GCP = 3;
export const BUILD_SCRIPT = "gcp-1-build.sh";
export const INSPECT_SCRIPT = "gcp-2-inspect.sh";
const SELF = fileURLToPath(import.meta.url);
const RUNNER = path.join("scripts", "run-ovd419-final-digest-release.mjs");

export function defaultWorktree(sha) {
  return path.join(os.homedir(), `ovd527-wt-${sha}`);
}

function gitIn(cwd, args, refusal) {
  try {
    return execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new PacketError(refusal);
  }
}

/** Create the detached candidate worktree if absent; refuse a SHA that is not merged. */
export function ensureWorktree({ sha, repo, worktree }) {
  gitIn(repo, ["cat-file", "-e", `${sha}^{commit}`], `commit ${sha} is not in ${repo}; run git fetch origin`);
  gitIn(repo, ["merge-base", "--is-ancestor", sha, "origin/main"],
    `commit ${sha} is not on origin/main; merge it first, or run git fetch origin`);
  if (!existsSync(worktree)) {
    gitIn(repo, ["worktree", "add", "--detach", worktree, sha], `could not create worktree ${worktree}`);
  }
  const [top, head] = gitIn(worktree, ["rev-parse", "--show-toplevel", "HEAD"], `${worktree} is not a git checkout`)
    .trim().split("\n");
  if (realpathSync(top) !== realpathSync(worktree)) throw new PacketError(`${worktree} is not a checkout's top level`);
  if (head !== sha) throw new PacketError(`worktree ${worktree} is at ${head}, not ${sha}`);
  const status = gitIn(worktree, ["status", "--porcelain=v1", "--untracked-files=all"], "git status failed");
  if (status.trim() !== "") throw new PacketError(`worktree ${worktree} is dirty`);
}

/** A literal shell word: what the echo lines below print, quotes included. */
function literal(text) {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** The two scripts that need GCP access. Both are rerun-safe and write outputs atomically. */
export function renderGcpScripts(source, packetDir, rerun) {
  const file = (name) => quote(path.join(packetDir, name));
  const say = (text) => `echo ${literal(text)}`;
  const steps = commandSteps(source, packetDir, {
    buildJson: path.join(packetDir, "build.json.partial"),
    inspectJson: path.join(packetDir, "inspect.json.partial"),
  });
  const { project, region } = OVD419_DIGEST_CONTRACT;
  const build = `#!/bin/bash
# OVD-527 GCP step 1 of 2 for ${source.commit}: one build only Cloud Build, then its record.
# Needs gcloud access to ${project}. The build is billed. A rerun reuses build-id.txt
# and never submits a second build; to start a new one, delete build-id.txt and build.json.
# Nothing here deploys or changes Cloud Run, the database, or any provider.
# Source archive SHA-256:  ${source.archiveSha256}
# Source manifest SHA-256: ${source.manifestSha256}
set -eu -o pipefail
ID_FILE=${file("build-id.txt")}
if [[ -s "$ID_FILE" ]]; then
  BUILD_ID="$(cat "$ID_FILE")"
  echo "Reusing build $BUILD_ID from build-id.txt; not submitting another."
else
${steps.submit}[[ -n "$BUILD_ID" ]] || { echo "No build id; stop."; exit 1; }
printf '%s\\n' "$BUILD_ID" > "$ID_FILE"
fi

${steps.follow}
${steps.saveBuild}mv ${file("build.json.partial")} ${file("build.json")}
${say(`Saved build.json. Next: bash ${file(INSPECT_SCRIPT)}`)}
`;
  const inspect = `#!/bin/bash
# OVD-527 GCP step 2 of 2 for ${source.commit}: resolve, pull and inspect the image offline.
# Needs gcloud access to ${project} and a running Docker that can pull from
# ${region}-docker.pkg.dev. Read only: nothing is pushed, deployed or changed.
set -eu -o pipefail
[[ -s ${file("build.json")} ]] || { ${say(`Run bash ${file(BUILD_SCRIPT)} first.`)}; exit 1; }
docker info >/dev/null 2>&1 || { echo "Start Docker, then rerun this script."; exit 1; }

${steps.pin}
${steps.inspect}mv ${file("inspect.json.partial")} ${file("inspect.json")}
${say(`Saved inspect.json. Next: ${rerun}`)}
`;
  return { [BUILD_SCRIPT]: build, [INSPECT_SCRIPT]: inspect };
}

/** Which packet output is still missing. */
export function nextGcpScript(packetDir) {
  if (!existsSync(path.join(packetDir, "build.json"))) return BUILD_SCRIPT;
  if (!existsSync(path.join(packetDir, "inspect.json"))) return INSPECT_SCRIPT;
  return null;
}

export function parsePlanVerdict(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout).trim());
  } catch {
    parsed = null;
  }
  if (parsed?.verdict !== "plan-valid") throw new PacketError("release runner did not report plan-valid");
  return parsed;
}

/** Validate with the candidate's own runner, the code the OVD-419 controller will run. */
export function candidatePlanCheck({ worktree, bundleText }) {
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [RUNNER, "--plan-stdin"], {
      cwd: worktree,
      input: bundleText,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    const said = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim().split("\n")[0].slice(0, 200);
    throw new PacketError(`${path.join(worktree, RUNNER)} did not accept the bundle${said ? `: ${said}` : ""}`);
  }
  return parsePlanVerdict(stdout);
}

export function qualifyCandidate({ sha, repo, worktree, outDir, rerun, log }) {
  if (!isFullSha(sha)) throw new PacketError("--sha must be a full 40 character lowercase SHA");
  ensureWorktree({ sha, repo, worktree });
  const outPath = path.resolve(outDir);
  const fresh = !existsSync(path.join(outPath, "source.json"));
  const packetDir = fresh
    ? createSourcePacket({ sha, cwd: worktree, outDir: outPath }).packetDir
    : realpathSync(outPath);
  const source = loadPacket(packetDir);
  if (source.commit !== sha) throw new PacketError("packet commit does not match --sha");
  const scripts = renderGcpScripts(source, packetDir, rerun);
  for (const [name, text] of Object.entries(scripts)) writeFileSync(path.join(packetDir, name), text);
  log(`OVD-527 candidate ${sha}\nworktree ${worktree} (clean)\npacket   ${packetDir}${fresh ? " (new)" : ""}
archive sha256 ${source.archiveSha256}, manifest sha256 ${source.manifestSha256}\n`);

  const next = nextGcpScript(packetDir);
  if (next) {
    const pending = next === BUILD_SCRIPT ? [BUILD_SCRIPT, INSPECT_SCRIPT] : [INSPECT_SCRIPT];
    log(`\nThese steps need GCP access; this tool runs neither gcloud nor docker. Run in order:\n${
      pending.map((name) => `  bash ${quote(path.join(packetDir, name))}\n`).join("")}then rerun: ${rerun}\n`);
    for (const name of pending) log(`\n----- ${name} -----\n${scripts[name]}`);
    return { state: "needs-gcp", next, packetDir };
  }

  let bundle;
  try {
    bundle = assembleBundle({
      source,
      buildOutput: readJsonFile(path.join(packetDir, "build.json"), "build.json"),
      inspectOutput: readJsonFile(path.join(packetDir, "inspect.json"), "inspect.json"),
    });
  } catch (error) {
    if (!(error instanceof PacketError)) throw error;
    throw new PacketError(`${error.message}. Delete the bad build.json or inspect.json and rerun its \
GCP script; a failed build also needs build-id.txt deleted, which starts a new billed build`, error.failures);
  }
  const bundleText = stableJson(bundle);
  candidatePlanCheck({ worktree, bundleText });
  const bundleFile = path.join(packetDir, "bundle.json");
  if (existsSync(bundleFile) && readFileSync(bundleFile, "utf8") !== bundleText) {
    throw new PacketError("bundle.json differs from the saved evidence; move it aside to rebuild it");
  }
  writeFileSync(bundleFile, bundleText);
  const digest = bundle.record.image.split("@")[1];
  log(`\nplan-valid (checked by ${path.join(worktree, RUNNER)})
image  ${bundle.record.image}
build  ${bundle.buildEvidence.build.id}
bundle ${bundleFile}

Build evidence only. Promotion is protected and needs Blaine's exact approval.
OVD-419 kit constants: SHA=${sha} DIGEST=${digest} WT=${worktree}
${existsSync(path.join(worktree, "node_modules")) ? "" : `The kit runs npm scripts in the worktree; run npm ci there first.\n`}`);
  return { state: "plan-valid", bundle, packetDir };
}

const USAGE = `usage: node scripts/ovd527-qualify-candidate.mjs --sha <full sha> [--worktree <dir>] [--out <dir>]
Defaults: --worktree ~/ovd527-wt-<sha>, --out ~/ovd527-packet/<sha>.
`;

export function runCli({
  args = process.argv.slice(2),
  cwd = process.cwd(),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  try {
    let flags;
    try {
      flags = parseFlags(args, ["--sha", "--worktree", "--out"]);
    } catch {
      flags = {};
    }
    const sha = flags["--sha"];
    if (!sha) {
      stderr.write(USAGE);
      return 2;
    }
    const worktree = path.resolve(cwd, flags["--worktree"] ?? defaultWorktree(sha));
    const outDir = path.resolve(cwd, flags["--out"] ?? defaultPacketDir(sha));
    const rerun = [`node ${quote(SELF)} --sha ${sha}`,
      ...(flags["--worktree"] ? [`--worktree ${quote(worktree)}`] : []),
      ...(flags["--out"] ? [`--out ${quote(outDir)}`] : [])].join(" ");
    const result = qualifyCandidate({
      sha, repo: cwd, worktree, outDir, rerun, log: (text) => stdout.write(text),
    });
    return result.state === "plan-valid" ? 0 : NEEDS_GCP;
  } catch (error) {
    if (!(error instanceof PacketError)) throw error;
    stderr.write(`ovd527 refused: ${error.message}\n`);
    for (const failure of error.failures) stderr.write(`  - ${failure}\n`);
    return 1;
  }
}

if (isDirectCli(import.meta.url)) process.exitCode = runCli();
