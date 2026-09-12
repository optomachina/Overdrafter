import { createHash } from "node:crypto";
import { readFile, readdir, lstat, stat, realpath, open, mkdir, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { compareCodeUnits, digest, validateApproval, TARGET, PROPOSAL } from "./ovd419-job-diagnostic.mjs";
import { attestBuildOnly } from "./run-ovd419-final-digest-release.mjs";

const exec = promisify(execFile);
const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
function reject() { throw new Error("diagnostic_binding_rejected"); }
const inside = (root, child) => child.startsWith(`${root}${path.sep}`);

/** Read one ordinary owned file without following a substituted link or torn write. */
export async function readBoundFile(file, maxBytes = 16 * 1024 * 1024) {
  if (!path.isAbsolute(file) || await realpath(file) !== file) reject();
  const before = await lstat(file);
  if (!before.isFile() || before.size > maxBytes || (before.mode & 0o022) !== 0) reject();
  const handle = await open(file, "r");
  try {
    const opened = await handle.stat();
    if (before.ino !== opened.ino || before.dev !== opened.dev) reject();
    const bytes = await handle.readFile(); const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || bytes.length !== before.size) reject();
    return bytes;
  } finally { await handle.close(); }
}

/** Hash the entire code tree, including link targets; escaping links/cycles reject. */
export async function treeDigest(root) {
  if (!path.isAbsolute(root) || await realpath(root) !== root) reject();
  const entries = []; let totalBytes = 0;
  async function walk(directory, logical, ancestors) {
    const resolved = await realpath(directory);
    if (resolved !== root && !inside(root, resolved)) reject();
    if (ancestors.has(resolved)) reject();
    const chain = new Set([...ancestors, resolved]);
    for (const name of (await readdir(directory)).sort(compareCodeUnits)) {
      const file = path.join(directory, name), rel = path.posix.join(logical, name);
      const metadata = await lstat(file), target = await realpath(file);
      if (!inside(root, target) || (metadata.mode & 0o022) !== 0 && !metadata.isSymbolicLink()) reject();
      if (entries.length >= 100000) reject();
      const actual = await stat(target);
      if (actual.isDirectory()) {
        entries.push({ path: rel, directory: true, link: metadata.isSymbolicLink() ? path.relative(root, target) : null });
        await walk(target, rel, chain);
      } else if (actual.isFile()) {
        totalBytes += actual.size; if (totalBytes > 1024 ** 3) reject();
        const bytes = await readBoundFile(target, 256 * 1024 * 1024);
        entries.push({ path: rel, sha256: hashBytes(bytes), mode: actual.mode & 0o777, link: metadata.isSymbolicLink() ? path.relative(root, target) : null });
      } else reject();
    }
  }
  await walk(root, "", new Set());
  return digest(entries);
}

/** Verify bytes and complete code/dependency/tool trees; never import unverified code. */
export async function verifyArtifactBindings(packet, { runtime = false } = {}) {
  const sources = {};
  for (const [role, artifact] of Object.entries(packet.artifacts)) {
    const bytes = await readBoundFile(artifact.path, 256 * 1024 * 1024);
    if (hashBytes(bytes) !== artifact.sha256) reject();
    if (["bundle", "proposal"].includes(role)) sources[role] = bytes;
  }
  for (const tree of Object.values(packet.trees)) if (await treeDigest(tree.path) !== tree.sha256) reject();
  if (hashBytes(sources.proposal) !== PROPOSAL) reject();
  const scripts = packet.trees.scripts.path;
  const expectedNames = { controller: "run-ovd419-live-release.mjs", launcher: "run-ovd419-job-diagnostic.mjs", runtimeModule: "ovd419-diagnostic-runtime.mjs", resultReader: "ovd419-diagnostic-adapter.mjs" };
  for (const [role, name] of Object.entries(expectedNames)) if (packet.artifacts[role].path !== path.join(scripts, name)) reject();
  if (packet.artifacts.rootLock.path !== path.join(path.dirname(scripts), "package-lock.json") || packet.artifacts.workerLock.path !== path.join(path.dirname(scripts), "worker/package-lock.json")) reject();
  if (!inside(packet.trees.gcloud.path, packet.artifacts.gcloud.path) || !inside(packet.trees.python.path, packet.artifacts.python.path)) reject();
  const bundle = JSON.parse(sources.bundle.toString("utf8"));
  attestBuildOnly(bundle.record, bundle.buildEvidence);
  if (bundle.record.image !== packet.image) reject();
  if (runtime) {
    if (packet.artifacts.node.path !== await realpath(process.execPath)) reject();
    if (process.env.NODE_OPTIONS || process.env.NODE_PATH || process.execArgv.length !== 0) reject();
    if (packet.trees.dependencies.path !== await realpath(path.join(path.dirname(scripts), "node_modules"))) reject();
    if (path.dirname(fileURLToPath(import.meta.url)) !== scripts) reject();
    const { stdout } = await exec("/usr/bin/git", ["-C", path.dirname(scripts), "rev-parse", "HEAD"], { timeout: 30000, maxBuffer: 1024 });
    const status = await exec("/usr/bin/git", ["-C", path.dirname(scripts), "status", "--porcelain", "--untracked-files=all"], { timeout: 30000, maxBuffer: 1024 * 1024 });
    if (stdout.trim() !== packet.sourceCommit || status.stdout.length !== 0) reject();
  }
  return true;
}

/**
 * Acquire an actual user message from the local Codex transcript trust boundary.
 * The reference is only a locator; its claimed role/text/timestamp is never trusted.
 * Binding the byte prefix permits later transcript append without permitting edits.
 */
export async function readDirectApproval(reference, packet, now) {
  if (!reference || Object.keys(reference).sort(compareCodeUnits).join() !== "line,path,prefixSha256") reject();
  const root = await realpath(path.join(homedir(), ".codex/sessions"));
  if (!inside(root, reference.path) || !reference.path.endsWith(".jsonl") || !Number.isSafeInteger(reference.line) || reference.line < 2 || !/^[0-9a-f]{64}$/.test(reference.prefixSha256)) reject();
  const bytes = await readBoundFile(reference.path, 256 * 1024 * 1024);
  if ((await stat(reference.path)).uid !== process.getuid()) reject();
  const lines = bytes.toString("utf8").split("\n");
  if (reference.line > lines.length - 1) reject();
  const prefix = Buffer.from(lines.slice(0, reference.line).join("\n") + "\n");
  if (hashBytes(prefix) !== reference.prefixSha256) reject();
  const session = JSON.parse(lines[0]);
  if (session.type !== "session_meta" || session.payload?.id !== TARGET.ownerTask) reject();
  for (const line of lines.slice(reference.line)) {
    if (!line.trim()) continue;
    const subsequent = JSON.parse(line);
    if (subsequent.type === "response_item" && subsequent.payload?.role === "user") reject();
  }
  const message = JSON.parse(lines[reference.line - 1]);
  if (message.type !== "response_item" || message.payload?.type !== "message" || message.payload?.role !== "user") reject();
  const content = message.payload.content;
  if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "input_text") reject();
  const approval = { packetSha256: digest(packet), issuedAt: message.timestamp, expiresAt: packet.expiresAt, ownerTask: TARGET.ownerTask,
    transcript: { role: "user", threadId: session.payload.id, timestamp: message.timestamp, text: content[0].text, prefixSha256: reference.prefixSha256 } };
  validateApproval(approval, packet, now);
  return approval;
}

/** Atomic durable one-use admission. A test root writes only inadmissible test records. */
export function createDiskAdmission({ testOnlyRoot } = {}) {
  const testOnly = testOnlyRoot !== undefined;
  if (testOnly && (!path.isAbsolute(testOnlyRoot) || !path.basename(testOnlyRoot).startsWith("ovd419-TEST-ONLY-"))) reject();
  const lock = testOnly ? path.join(testOnlyRoot, "TEST-ONLY-owner") : path.join(tmpdir(), "overdrafter-ovd419-live-release.lock");
  const state = testOnly ? path.join(testOnlyRoot, "TEST-ONLY-consumed") : path.join(homedir(), ".codex/ovd419-diagnostic-consumed");
  let handle, ownerBytes;
  return Object.freeze({
    testOnly,
    async acquire() {
      if (handle) reject();
      await mkdir(lock, { mode: 0o700 }); // Existing live or sentinel owner always rejects.
      ownerBytes = JSON.stringify({ schema: testOnly ? "TEST-ONLY-NOT-AUTHORITY" : "ovd419-job-diagnostic-owner-v1", pid: process.pid, ownerTask: TARGET.ownerTask });
      try { handle = await open(path.join(lock, "owner.json"), "wx", 0o600); await handle.writeFile(ownerBytes); await handle.sync(); }
      catch { reject(); } // Preserve partial ownership rather than clearing uncertainty.
    },
    async assert() {
      if (!handle) reject();
      const directory = await lstat(lock), file = await lstat(path.join(lock, "owner.json")), current = await handle.stat();
      if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o077) !== 0 || file.ino !== current.ino || file.dev !== current.dev || file.uid !== process.getuid() || (file.mode & 0o077) !== 0 || await realpath(lock) !== path.join(await realpath(path.dirname(lock)), path.basename(lock))) reject();
      if ((await readFile(path.join(lock, "owner.json"), "utf8")) !== ownerBytes) reject();
    },
    async consume(id) {
      await this.assert(); if (!/^[0-9a-f]{64}$/.test(id)) reject();
      await mkdir(state, { mode: 0o700, recursive: true });
      const directory = await lstat(state);
      if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o077) !== 0 || await realpath(state) !== state) reject();
      const record = await open(path.join(state, `${id}.json`), "wx", 0o600);
      try { await record.writeFile(JSON.stringify({ schema: testOnly ? "TEST-ONLY-NOT-AUTHORITY" : "ovd419-job-diagnostic-consumed-v1", id })); await record.sync(); }
      finally { await record.close(); }
      const dir = await open(state, "r"); try { await dir.sync(); } finally { await dir.close(); }
    },
    async release() {
      await this.assert(); await handle.close(); handle = undefined;
      await rm(path.join(lock, "owner.json")); await rmdir(lock);
    },
  });
}
