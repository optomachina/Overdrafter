#!/usr/bin/env node
// Bootstrap imports are builtins only. Application imports occur after byte gates.
import { createHash } from "node:crypto";
import { readFile, readdir, realpath, lstat, stat, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (v) => {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
};
const jsonHash = (v) => sha(JSON.stringify(canonical(v)));
function reject() { throw new Error("diagnostic_bootstrap_rejected"); }

/** Authenticate exact user provenance before importing any non-builtin source. */
export async function bootstrapApproval(packet, reference, now = Date.now()) {
  const root = await realpath(path.join(homedir(), ".codex/sessions"));
  if (!reference || Object.keys(reference).sort().join() !== "line,path,prefixSha256" || typeof reference.path !== "string" || !reference.path.startsWith(`${root}/`) || !reference.path.endsWith(".jsonl") || await realpath(reference.path) !== reference.path || !Number.isSafeInteger(reference.line) || reference.line < 2 || !/^[0-9a-f]{64}$/.test(reference.prefixSha256)) reject();
  const meta = await lstat(reference.path);
  if (!meta.isFile() || meta.uid !== process.getuid() || meta.size > 256 * 1024 * 1024 || (meta.mode & 0o022) !== 0) reject();
  const lines = (await readFile(reference.path, "utf8")).split("\n");
  return verifyTranscriptLines(lines, reference, packet, now);
}

/** Pure transcript-prefix verifier; fixtures stay in memory and cannot admit execution. */
export function verifyTranscriptLines(lines, reference, packet, now) {
  const owner = "01a07d04-7c70-7260-a383-d5d4e21018e9";
  const proposal = "7ab0649abe5fef7ac4ce4b6dfd5a0d205872b542169c1ae908b8911763ecf0b7";
  if (reference.line > lines.length - 1 || sha(lines.slice(0, reference.line).join("\n") + "\n") !== reference.prefixSha256) reject();
  const session = JSON.parse(lines[0]), message = JSON.parse(lines[reference.line - 1]);
  for (const line of lines.slice(reference.line)) {
    if (!line.trim()) continue;
    const subsequent = JSON.parse(line);
    if (subsequent.type === "response_item" && subsequent.payload?.role === "user") reject();
  }
  const content = message.payload?.content;
  const text = `I, Blaine Wilson, approve one OVD-419 Job-only authentication diagnostic under packet ${jsonHash(packet)} and proposal ${proposal}, owned by ${owner}, in overdrafter-worker-9133/us-west1, expiring ${packet.expiresAt}; zero retries, unchanged Service, automatic Job restoration, and the disclosed dependency risk and bounded costs accepted.`;
  const issued = Date.parse(message.timestamp), expires = Date.parse(packet.expiresAt);
  if (packet.schema !== "ovd419-job-diagnostic-v2" || packet.proposalSha256 !== proposal || packet.ownerTask !== owner || session.type !== "session_meta" || session.payload?.id !== owner || message.type !== "response_item" || message.payload?.type !== "message" || message.payload?.role !== "user" || !Array.isArray(content) || content.length !== 1 || content[0]?.type !== "input_text" || content[0].text !== text || !Number.isFinite(issued) || !Number.isFinite(expires) || issued > now || expires <= now || expires - issued > 1800000 || expires <= issued) reject();
  return { packetSha256: jsonHash(packet), issuedAt: message.timestamp, expiresAt: packet.expiresAt, ownerTask: owner,
    transcript: { role: "user", threadId: owner, timestamp: message.timestamp, text: content[0].text, prefixSha256: reference.prefixSha256 } };
}

/** Builtin-only gate: substituted helpers/dependencies never execute before hashing. */
export async function bootstrapBytes(packet, launcherPath = fileURLToPath(import.meta.url)) {
  if (!packet?.artifacts || !packet?.trees || packet.artifacts.launcher?.path !== launcherPath) reject();
  const scripts = path.dirname(launcherPath);
  if (packet.trees.scripts?.path !== scripts || packet.trees.dependencies?.path !== await realpath(path.join(path.dirname(scripts), "node_modules"))) reject();
  let count = 0, size = 0;
  async function bytes(file, maximum = 256 * 1024 * 1024) {
    if (!path.isAbsolute(file) || await realpath(file) !== file) reject();
    const before = await lstat(file);
    if (!before.isFile() || before.size > maximum || (before.mode & 0o022) !== 0) reject();
    const value = await readFile(file), after = await lstat(file);
    if (before.ino !== after.ino || before.dev !== after.dev || before.size !== value.length || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) reject();
    return value;
  }
  for (const artifact of Object.values(packet.artifacts)) {
    if (!artifact || !/^[0-9a-f]{64}$/.test(artifact.sha256) || sha(await bytes(artifact.path)) !== artifact.sha256) reject();
  }
  if (Object.keys(packet.trees).sort().join() !== "dependencies,gcloud,python,scripts") reject();
  for (const tree of Object.values(packet.trees)) {
    const root = tree.path, entries = [];
    if (!path.isAbsolute(root) || await realpath(root) !== root) reject();
    async function walk(directory, logical, ancestors) {
      const resolved = await realpath(directory);
      if ((resolved !== root && !resolved.startsWith(`${root}/`)) || ancestors.has(resolved)) reject();
      const chain = new Set([...ancestors, resolved]);
      for (const name of (await readdir(directory)).sort()) {
        const file = path.join(directory, name), rel = path.posix.join(logical, name);
        const metadata = await lstat(file), target = await realpath(file), actual = await stat(target);
        if (!target.startsWith(`${root}/`) || ++count > 100000 || ((metadata.mode & 0o022) !== 0 && !metadata.isSymbolicLink())) reject();
        const link = metadata.isSymbolicLink() ? path.relative(root, target) : null;
        if (actual.isDirectory()) { entries.push({ path: rel, directory: true, link }); await walk(target, rel, chain); }
        else if (actual.isFile()) {
          size += actual.size; if (size > 1024 ** 3) reject();
          entries.push({ path: rel, sha256: sha(await bytes(target)), mode: actual.mode & 0o777, link });
        } else reject();
      }
    }
    await walk(root, "", new Set());
    if (jsonHash(entries) !== tree.sha256) reject();
  }
}

async function privateJson(file) {
  if (!path.isAbsolute(file) || await realpath(file) !== file) reject();
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0 || metadata.size > 16 * 1024 * 1024) reject();
  return JSON.parse(await readFile(file, "utf8"));
}

/** Explicit future execution CLI. Importing the module performs no operation. */
export async function runDiagnosticCli(args = process.argv.slice(2)) {
  if (args.length !== 7 || args[0] !== "--execute" || args[1] !== "--packet-file" || args[3] !== "--approval-reference-file" || args[5] !== "--evidence-file") {
    process.stderr.write("OVD-419 diagnostic requires a fully bound packet, direct approval reference, and private evidence path.\n"); return 2;
  }
  let output, signalRequested = false, persistAttempts = 0;
  const stop = () => { signalRequested = true; };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    if (process.execArgv.length || process.env.NODE_OPTIONS || process.env.NODE_PATH) reject();
    const packetInput = await privateJson(args[2]);
    const reference = await privateJson(args[4]);
    await bootstrapApproval(packetInput, reference);
    await bootstrapBytes(packetInput);
    const { validatePacket, runDiagnostic, validateApproval } = await import("./ovd419-job-diagnostic.mjs");
    const { verifyArtifactBindings, readDirectApproval, createDiskAdmission } = await import("./ovd419-diagnostic-bindings.mjs");
    const packet = validatePacket(packetInput, Date.now());
    const verifyBindings = () => verifyArtifactBindings(packet, { runtime: true });
    await verifyBindings();
    const approval = await readDirectApproval(reference, packet, Date.now());
    const outputPath = args[6], repo = path.dirname(packet.trees.scripts.path);
    const evidenceRoot = await realpath(tmpdir());
    const parent = await lstat(path.dirname(outputPath));
    if (outputPath !== packet.evidencePath || !outputPath.startsWith(`${evidenceRoot}/ovd419-diagnostic-evidence-`) || !parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o077) !== 0) reject();
    if (!path.isAbsolute(outputPath) || outputPath === repo || outputPath.startsWith(`${repo}/`) || await realpath(path.dirname(outputPath)) !== path.dirname(outputPath)) reject();
    output = await open(outputPath, "wx", 0o600);
    const admission = createDiskAdmission();
    if (admission.testOnly) reject();
    const { createDiagnosticAdapter } = await import("./ovd419-diagnostic-adapter.mjs");
    const adapter = createDiagnosticAdapter(packet, { verifyBindings, assertOwnership: () => admission.assert(),
      beforeMutation: async (recovery) => {
        await verifyBindings(); await admission.assert();
        if (!recovery) {
          validateApproval(await readDirectApproval(reference, packet, Date.now()), packet, Date.now());
          if (signalRequested) reject();
        }
      } });
    const persist = async (receipt) => {
      if (++persistAttempts > 2) reject();
      await output.writeFile(JSON.stringify(receipt) + "\n"); await output.sync();
    };
    const operations = { ...adapter, persist };
    const result = await runDiagnostic({ packet, approval, operations, admission,
      now: Date.now, wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), interrupted: () => signalRequested });
    if (persistAttempts === 0) await persist(result);
    process.stdout.write(`OVD-419 diagnostic ${result.status}; retry not authorized.\n`);
    return result.status === "diagnostic_succeeded" ? 0 : 1;
  } catch {
    if (output && persistAttempts === 0) { await output.writeFile('{"status":"failed","containment":"unproved","retryAuthorized":false}\n').catch(() => {}); await output.sync().catch(() => {}); }
    process.stderr.write("OVD-419 diagnostic stopped; no retry authorized. Inspect private bounded evidence and ownership state.\n"); return 1;
  } finally {
    if (output) await output.close().catch(() => {});
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runDiagnosticCli();
