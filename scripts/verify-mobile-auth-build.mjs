/**
 * Verify that a production build preserves the mobile-auth deployment contract.
 *
 * This post-build gate checks the two fixed authentication entrypoints, the
 * hashed SPA entry, and the mobile-auth module graph for server-secret markers.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distributionRoot = path.join(repositoryRoot, "dist");
const mobileAuthSourceRoot = path.join(repositoryRoot, "server", "mobile-auth");
const mobileAuthApiSource = path.join(repositoryRoot, "api", "mobile-auth.ts");
const stableMobileAuthAssets = [
  path.join(distributionRoot, "assets", "mobile-auth.js"),
  path.join(distributionRoot, "assets", "mobile-bootstrap.js"),
];
const serverSecretMarkers = [
  "MOBILE_AUTH_KEYRING",
  "MOBILE_AUTH_CURRENT_KEY_VERSION",
  "SUPABASE_SERVICE_ROLE_KEY",
  "CRON_SECRET",
];

async function assertNonEmptyFile(filePath) {
  const fileStats = await stat(filePath);
  if (!fileStats.isFile() || fileStats.size === 0) {
    throw new Error(`Expected a non-empty build artifact at ${path.relative(repositoryRoot, filePath)}.`);
  }
}

function readRelativeModuleImports(contents) {
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  const specifiers = [];

  for (const pattern of patterns) {
    for (const match of contents.matchAll(pattern)) {
      if (match[1].startsWith(".")) {
        specifiers.push(match[1]);
      }
    }
  }

  return specifiers;
}

async function collectMobileAuthModuleGraph() {
  const pending = [...stableMobileAuthAssets];
  const visited = new Set();

  while (pending.length > 0) {
    const filePath = pending.pop();
    if (!filePath || visited.has(filePath)) {
      continue;
    }

    const relativePath = path.relative(distributionRoot, filePath);
    if (
      relativePath === "" ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error("A mobile-auth build import escaped the distribution directory.");
    }

    const contents = await readFile(filePath, "utf8");
    visited.add(filePath);

    for (const specifier of readRelativeModuleImports(contents)) {
      pending.push(path.resolve(path.dirname(filePath), specifier));
    }
  }

  return [...visited];
}

async function verifyStableEntryAssets() {
  for (const assetPath of stableMobileAuthAssets) {
    await assertNonEmptyFile(assetPath);
  }
}

async function verifyNodeEsmSourceImports() {
  const serverSourceFiles = (await readdir(mobileAuthSourceRoot))
    .filter((fileName) => fileName.endsWith(".ts") && !fileName.endsWith(".test.ts"))
    .map((fileName) => path.join(mobileAuthSourceRoot, fileName));

  for (const filePath of [mobileAuthApiSource, ...serverSourceFiles]) {
    const contents = await readFile(filePath, "utf8");
    const invalidSpecifier = readRelativeModuleImports(contents).find(
      (specifier) => !specifier.endsWith(".js"),
    );

    if (invalidSpecifier) {
      throw new Error(
        `Node ESM import ${invalidSpecifier} in ${path.relative(repositoryRoot, filePath)} must use a .js extension.`,
      );
    }
  }
}

async function verifyHashedSpaEntry() {
  const indexPath = path.join(distributionRoot, "index.html");
  const indexHtml = await readFile(indexPath, "utf8");
  const scriptSources = [...indexHtml.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(
    (match) => match[1],
  );
  const spaEntries = scriptSources.filter((source) =>
    /^\/assets\/main-[A-Za-z0-9_-]+\.js$/.test(source),
  );

  if (spaEntries.length !== 1) {
    throw new Error("Expected exactly one hashed SPA entry in dist/index.html.");
  }

  await assertNonEmptyFile(path.join(distributionRoot, spaEntries[0].slice(1)));
}

async function verifyServerSecretsAreAbsent() {
  const outputFiles = await collectMobileAuthModuleGraph();

  for (const filePath of outputFiles) {
    const contents = await readFile(filePath, "utf8");
    const marker = serverSecretMarkers.find((candidate) => contents.includes(candidate));
    if (marker) {
      throw new Error(
        `Server-secret marker ${marker} was found in ${path.relative(repositoryRoot, filePath)}.`,
      );
    }
  }
}

async function main() {
  await verifyNodeEsmSourceImports();
  await verifyStableEntryAssets();
  await verifyHashedSpaEntry();
  await verifyServerSecretsAreAbsent();
  console.log("Mobile authentication build artifacts verified.");
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Mobile authentication build verification failed.");
  process.exitCode = 1;
}
