/** Offline source-build evidence only; never qualifies a deployed image. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const run = (command, args, cwd, input) => execFileSync(command, args, {
  cwd, input, encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    npm_config_cache: process.env.npm_config_cache ?? join(process.env.HOME, ".npm"),
    npm_config_logs_dir: join(cwd, "npm-logs"), PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
});

/** Replay retained synthetic expectations through both source and compiled code. */
export function checkScopes(buildRoot, packet, compiledPath = join(buildRoot, "worker/dist/quoteScope.js")) {
  if (!packet.cases?.length || !["retained-source", "retained-sql"].includes(packet.expectationKind)) {
    throw new Error("Expected nonempty retained-source or retained-sql replay packet");
  }
  const harness = readFileSync(join(buildRoot, "scripts/check-sourcing-worker-scope.mjs"), "utf8");
  const compiledHarness = harness.replace('"../worker/src/quoteScope.ts"', JSON.stringify(pathToFileURL(compiledPath).href));
  if (compiledHarness === harness) throw new Error("Source harness import changed; review compiled adapter");
  return packet.cases.map(({ name, input, expected }) => {
    if (!name || !input || !expected || (!expected.scope && !expected.error)) throw new Error("Invalid replay case");
    const source = JSON.parse(run(process.execPath, ["--experimental-strip-types", "scripts/check-sourcing-worker-scope.mjs"], buildRoot, JSON.stringify(input)));
    const compiled = JSON.parse(run(process.execPath, ["--input-type=module", "-e", compiledHarness], buildRoot, JSON.stringify(input)));
    if (!isDeepStrictEqual(source, expected)) throw new Error(`Retained expectation differs from source: ${name}`);
    if (!isDeepStrictEqual(compiled, expected)) throw new Error(`Compiled scope mismatch: ${name}`);
    return { name, matched: true, expectedSha256: hash(JSON.stringify(expected)) };
  });
}

/** Export an exact revision, install its lock offline, compile, and retain hashes. */
export function buildEvidence(revision, packetPath, outputPath) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("An explicit full source commit SHA is required");
  const resolved = run("git", ["rev-parse", `${revision}^{commit}`], root).trim();
  if (resolved !== revision) throw new Error("Source revision did not resolve exactly");
  const packetBytes = readFileSync(packetPath);
  const packet = JSON.parse(packetBytes);
  if (packet.sourceRevision !== revision) throw new Error("Replay packet source revision mismatch");
  const output = resolve(outputPath);
  // Exclusive directory prevents stale dist or old success receipts being reused.
  mkdirSync(output);
  const buildRoot = join(output, "source");
  mkdirSync(buildRoot);
  const archive = execFileSync("git", ["archive", revision], { cwd: root, maxBuffer: 128 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", buildRoot], { input: archive });
  const worker = join(buildRoot, "worker");
  run("npm", ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], worker);
  run(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], worker);
  const cases = checkScopes(buildRoot, packet);
  const modules = ["quoteScope", "xometryDispatchPreflight", "vendorQuoteOfferPersistence", "providerUploadCapabilityPersistence"];
  const paths = ["worker/package.json", "worker/package-lock.json", "worker/tsconfig.json",
    "scripts/check-sourcing-worker-scope.mjs",
    "supabase/migrations/20260926225000_confirm_sourcing_intent.sql",
    "supabase/fixtures/sourcing-intent/sourcing_worker_scope.sql",
    ...modules.flatMap((name) => [`worker/src/${name}.ts`, `worker/dist/${name}.js`])];
  const manifest = {
    schema: "compiled-worker-scope-evidence.v1", qualification: "offline-source-build-only",
    sourceRevision: revision, expectationKind: packet.expectationKind,
    sqlExecuted: false, imageQualified: false, node: process.version,
    npm: run("npm", ["--version"], worker).trim(),
    typescript: JSON.parse(readFileSync(join(worker, "node_modules/typescript/package.json"))).version,
    dependencyInstall: "npm ci --offline --ignore-scripts --no-audit --no-fund",
    workerVersion: JSON.parse(readFileSync(join(worker, "package.json"))).version,
    replayPacketSha256: hash(packetBytes), helperSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
    files: Object.fromEntries(paths.map((path) => [path, hash(readFileSync(join(buildRoot, path)))])), cases,
  };
  writeFileSync(join(output, "replay.json"), packetBytes, { flag: "wx" });
  writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [revision, packet, output, ...extra] = process.argv.slice(2);
    if (!revision || !packet || !output || extra.length) throw new Error("Usage: node scripts/check-compiled-worker-scope.mjs <full-source-sha> <replay.json> <new-output-directory>");
    console.log(JSON.stringify(buildEvidence(revision, resolve(packet), output), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
