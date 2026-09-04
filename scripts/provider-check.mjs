import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  WEB_CATALOG_RELATIVE_PATH,
  WORKER_CATALOG_RELATIVE_PATH,
  readCurrentVendorKeys,
  readProviderManifests,
} from "./provider-manifest.mjs";
import { assertSafeGeneratedOutput, syncProviderCatalogs } from "./provider-sync.mjs";

const REQUIRED_CONSUMER_MARKERS = new Map([
  ["src/features/quotes/vendor-colors.ts", "PROVIDER_CATALOG"],
  ["src/features/quotes/vendor-purchasing-links.ts", "PROVIDER_CATALOG"],
  ["src/features/quotes/utils.ts", "getVendorDisplayName"],
  ["src/features/quotes/sourcing-result.ts", "PROVIDER_CATALOG"],
]);

export function assertCheckedInProviderIdentity(manifest) {
  if (
    manifest.official.urls.length === 0 ||
    manifest.official.domains.length === 0 ||
    manifest.evidence.firstPartyUrls.length === 0 ||
    manifest.evidence.reviewedAt === null
  ) {
    throw new Error(`checked-in provider manifest ${manifest.key} requires current first-party identity evidence`);
  }
}

async function readProviderSchema(rootDir) {
  let schema;
  try {
    schema = JSON.parse(await fs.readFile(
      path.join(rootDir, "provider-integrations/provider-manifest.v1.schema.json"),
      "utf8",
    ));
  } catch {
    throw new Error("provider manifest JSON schema is missing or invalid");
  }
  if (schema.title !== "ProviderManifestV1" || schema.additionalProperties !== false) {
    throw new Error("provider manifest JSON schema does not define the closed V1 contract");
  }
}

function assertManifestKeysMatch(manifestKeys, vendorKeys) {
  if (JSON.stringify(manifestKeys) === JSON.stringify(vendorKeys)) {
    return;
  }
  const missing = vendorKeys.filter((key) => !manifestKeys.includes(key));
  const extra = manifestKeys.filter((key) => !vendorKeys.includes(key));
  throw new Error(`manifest/vendor enum mismatch; missing=[${missing.join(",")}] extra=[${extra.join(",")}]`);
}

async function assertGeneratedCatalogs(rootDir) {
  const expected = await syncProviderCatalogs({ rootDir, dryRun: true });
  for (const output of expected.rendered) {
    const outputPath = await assertSafeGeneratedOutput(rootDir, output.relativePath);
    let actual;
    try {
      actual = await fs.readFile(outputPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`generated provider catalog is missing: ${output.relativePath}`);
      }
      throw error;
    }
    if (actual !== output.contents) {
      throw new Error(`generated provider catalog is stale: ${output.relativePath}`);
    }
    if (/certified|admission|dispatchEnabled|productionAuthorized/i.test(actual)) {
      throw new Error(`generated provider catalog contains production authority language: ${output.relativePath}`);
    }
  }
}

async function assertCatalogConsumers(rootDir) {
  for (const [relativePath, marker] of REQUIRED_CONSUMER_MARKERS) {
    const source = await fs.readFile(path.join(rootDir, relativePath), "utf8");
    if (!source.includes(marker)) {
      throw new Error(`required catalog consumer is not wired: ${relativePath}`);
    }
  }
}

export async function checkProviderIntegrations({
  rootDir,
  today = new Date().toISOString().slice(0, 10),
  checkConsumers = true,
}) {
  await readProviderSchema(rootDir);
  const manifests = await readProviderManifests(rootDir, { today });
  manifests.forEach(({ manifest }) => assertCheckedInProviderIdentity(manifest));
  const manifestKeys = manifests
    .map(({ manifest }) => manifest.key)
    .sort((left, right) => {
      if (left < right) {
        return -1;
      }
      if (left > right) {
        return 1;
      }
      return 0;
    });
  const vendorKeys = await readCurrentVendorKeys(rootDir);
  assertManifestKeysMatch(manifestKeys, vendorKeys);
  await assertGeneratedCatalogs(rootDir);

  if (checkConsumers) {
    await assertCatalogConsumers(rootDir);
  }
  return {
    providerCount: manifests.length,
    vendorKeys,
    generatedOutputs: [WEB_CATALOG_RELATIVE_PATH, WORKER_CATALOG_RELATIVE_PATH],
  };
}

export async function runProviderCheckCli(argv = process.argv.slice(2), rootDir = process.cwd()) {
  if (argv.length > 0) {
    throw new Error(`unknown argument: ${argv[0]}`);
  }
  const result = await checkProviderIntegrations({ rootDir });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    await runProviderCheckCli();
  } catch (error) {
    process.stderr.write(`provider:check failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
