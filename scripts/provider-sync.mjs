import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  WEB_CATALOG_RELATIVE_PATH,
  WORKER_CATALOG_RELATIVE_PATH,
  buildCatalog,
  readProviderManifests,
  renderCatalog,
} from "./provider-manifest.mjs";

async function lstatIfPresent(targetPath) {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function assertSafeGeneratedOutput(rootDir, relativePath) {
  const outputPath = path.join(rootDir, relativePath);
  const parentSegments = path.dirname(relativePath).split(path.sep);
  let currentPath = rootDir;
  for (const segment of parentSegments) {
    currentPath = path.join(currentPath, segment);
    const stat = await lstatIfPresent(currentPath);
    if (!stat) {
      break;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`generated provider catalog parent must be a real directory: ${currentPath}`);
    }
  }
  const outputStat = await lstatIfPresent(outputPath);
  if (outputStat && (outputStat.isSymbolicLink() || !outputStat.isFile())) {
    throw new Error(`generated provider catalog output must be a regular file: ${relativePath}`);
  }
  return outputPath;
}

export async function syncProviderCatalogs({
  rootDir,
  dryRun = false,
  today = new Date().toISOString().slice(0, 10),
}) {
  const manifests = await readProviderManifests(rootDir, { today });
  const catalog = buildCatalog(manifests);
  const outputs = [
    { relativePath: WEB_CATALOG_RELATIVE_PATH, contents: renderCatalog(catalog, "web") },
    { relativePath: WORKER_CATALOG_RELATIVE_PATH, contents: renderCatalog(catalog, "worker") },
  ];
  if (!dryRun) {
    const outputPaths = [];
    for (const output of outputs) {
      outputPaths.push(await assertSafeGeneratedOutput(rootDir, output.relativePath));
    }
    for (let index = 0; index < outputs.length; index += 1) {
      const output = outputs[index];
      const outputPath = outputPaths[index];
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, output.contents, "utf8");
    }
  }
  return {
    providerCount: manifests.length,
    dryRun,
    outputs: outputs.map((output) => output.relativePath),
    rendered: outputs,
  };
}

function parseArgs(argv) {
  for (const arg of argv) {
    if (arg !== "--dry-run") {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { dryRun: argv.includes("--dry-run") };
}

export async function runProviderSyncCli(argv = process.argv.slice(2), rootDir = process.cwd()) {
  const result = await syncProviderCatalogs({ rootDir, ...parseArgs(argv) });
  process.stdout.write(`${JSON.stringify({
    providerCount: result.providerCount,
    dryRun: result.dryRun,
    outputs: result.outputs,
  }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    await runProviderSyncCli();
  } catch (error) {
    process.stderr.write(`provider:sync refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
