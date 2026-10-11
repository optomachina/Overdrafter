import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import ts from "typescript";

import {
  WEB_CATALOG_RELATIVE_PATH,
  WORKER_CATALOG_RELATIVE_PATH,
  readCurrentVendorKeys,
  readProviderManifests,
} from "./provider-manifest.mjs";
import { assertSafeGeneratedOutput, syncProviderIntegrations } from "./provider-sync.mjs";
import {
  PROVIDER_REGISTRY_RELATIVE_PATH,
  PROVIDER_REGISTRY_SCHEMA_RELATIVE_PATH,
  WORKER_REGISTRY_RELATIVE_PATH,
  WORKER_SECRETS_SCRIPT_RELATIVE_PATH,
  assertGeneratedRegistryOutput,
  readProviderRegistry,
  readProviderRegistrySchema,
} from "./provider-registry.mjs";

const GENERATED_CATALOG_IMPORT = "@/features/quotes/generated/provider-catalog";
const REQUIRED_CATALOG_CONSUMERS = new Map([
  ["src/features/quotes/vendor-colors.ts", {
    importedName: "PROVIDER_CATALOG",
    moduleSpecifier: GENERATED_CATALOG_IMPORT,
  }],
  ["src/features/quotes/vendor-purchasing-links.ts", {
    importedName: "PROVIDER_CATALOG",
    moduleSpecifier: GENERATED_CATALOG_IMPORT,
  }],
  ["src/features/quotes/utils.ts", {
    importedName: "getVendorDisplayName",
    moduleSpecifier: "@/features/quotes/vendor-colors",
  }],
  ["src/features/quotes/sourcing-result.ts", {
    importedName: "PROVIDER_CATALOG",
    moduleSpecifier: GENERATED_CATALOG_IMPORT,
  }],
]);

function findImportedLocalName(sourceFile, importedName, moduleSpecifier) {
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== moduleSpecifier ||
      statement.importClause?.isTypeOnly ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }
    for (const binding of statement.importClause.namedBindings.elements) {
      if (!binding.isTypeOnly && (binding.propertyName?.text ?? binding.name.text) === importedName) {
        return binding.name.text;
      }
    }
  }
  return null;
}

function hasRuntimeReference(sourceFile, localName) {
  let found = false;
  function visit(node) {
    if (found || ts.isImportDeclaration(node)) {
      return;
    }
    if (ts.isIdentifier(node) && node.text === localName) {
      let ancestor = node.parent;
      while (ancestor && ancestor !== sourceFile) {
        if (ts.isTypeNode(ancestor)) {
          return;
        }
        ancestor = ancestor.parent;
      }
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  ts.forEachChild(sourceFile, visit);
  return found;
}

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

async function readRegistryContract(rootDir) {
  await readProviderRegistrySchema(rootDir);
  return readProviderRegistry(rootDir);
}

function assertManifestKeysMatch(manifestKeys, vendorKeys) {
  if (JSON.stringify(manifestKeys) === JSON.stringify(vendorKeys)) {
    return;
  }
  const missing = vendorKeys.filter((key) => !manifestKeys.includes(key));
  const extra = manifestKeys.filter((key) => !vendorKeys.includes(key));
  throw new Error(`manifest/vendor enum mismatch; missing=[${missing.join(",")}] extra=[${extra.join(",")}]`);
}

function generatedOutputKind(relativePath) {
  if (
    relativePath === WORKER_REGISTRY_RELATIVE_PATH
    || relativePath === WORKER_SECRETS_SCRIPT_RELATIVE_PATH
  ) {
    return "generated provider registry";
  }
  return "generated provider catalog";
}

async function assertGeneratedOutputs(rootDir, today) {
  const expected = await syncProviderIntegrations({ rootDir, dryRun: true, today });
  for (const output of expected.rendered) {
    const kind = generatedOutputKind(output.relativePath);
    const outputPath = await assertSafeGeneratedOutput(rootDir, output.relativePath, kind);
    let actual;
    try {
      actual = await fs.readFile(outputPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error(`${kind} is missing: ${output.relativePath}`);
      }
      throw error;
    }
    if (actual !== output.contents) {
      throw new Error(`${kind} is stale: ${output.relativePath}`);
    }
    if (kind === "generated provider registry") {
      assertGeneratedRegistryOutput(actual, output.relativePath);
    } else if (/certified|admission|dispatchEnabled|productionAuthorized/i.test(actual)) {
      throw new Error(`${kind} contains production authority language: ${output.relativePath}`);
    }
  }
  return expected;
}

async function assertCatalogConsumers(rootDir) {
  for (const [relativePath, requirement] of REQUIRED_CATALOG_CONSUMERS) {
    const source = await fs.readFile(path.join(rootDir, relativePath), "utf8");
    const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true);
    const localName = findImportedLocalName(
      sourceFile,
      requirement.importedName,
      requirement.moduleSpecifier,
    );
    if (!localName || !hasRuntimeReference(sourceFile, localName)) {
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
  const registry = await readRegistryContract(rootDir);
  const manifests = await readProviderManifests(rootDir, { today });
  manifests.forEach(({ manifest }) => assertCheckedInProviderIdentity(manifest));
  const manifestKeySet = new Set(manifests.map(({ manifest }) => manifest.key));
  for (const entry of registry.providers) {
    if (!manifestKeySet.has(entry.key)) {
      throw new Error(`provider registry key is not a checked-in manifest: ${entry.key}`);
    }
  }
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
  const generated = await assertGeneratedOutputs(rootDir, today);

  if (checkConsumers) {
    await assertCatalogConsumers(rootDir);
  }
  return {
    providerCount: manifests.length,
    vendorKeys,
    liveAdapters: generated.liveAdapters,
    generatedOutputs: [
      WEB_CATALOG_RELATIVE_PATH,
      WORKER_CATALOG_RELATIVE_PATH,
      WORKER_REGISTRY_RELATIVE_PATH,
      WORKER_SECRETS_SCRIPT_RELATIVE_PATH,
    ],
    registryPath: PROVIDER_REGISTRY_RELATIVE_PATH,
    registrySchemaPath: PROVIDER_REGISTRY_SCHEMA_RELATIVE_PATH,
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
