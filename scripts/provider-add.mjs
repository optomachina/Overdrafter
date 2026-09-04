import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  PROVIDER_MANIFEST_FILE,
  createProviderManifest,
  deriveDisplayName,
  deriveProviderKey,
  formatManifest,
  normalizeOfficialDomain,
  normalizeProviderUrl,
  readCurrentVendorKeys,
  readProviderManifests,
  validateProviderManifest,
} from "./provider-manifest.mjs";

const ENUM_STUB = "01-add-vendor-enum.sql.stub";
const POLICY_STUB = "02-add-disabled-admission-policy.sql.stub";

function enumStub(key) {
  return `-- REVIEW REQUIRED: move this statement into a Supabase CLI-created migration.\n-- This stub adds identity only. It does not enable routing or automation.\nalter type public.vendor_name add value if not exists '${key}';\n`;
}

function policyStub(key) {
  return `-- REVIEW REQUIRED: move this disabled row into a reviewed migration after the enum change.\n-- This stub is default-off and grants no dispatch, evaluation, or production authority.\ninsert into private.quote_provider_admission_policies (\n  provider,\n  admission_state,\n  generic_dispatch_enabled,\n  policy_revision,\n  evidence_reference,\n  permission_basis,\n  supported_processes,\n  accepted_file_extensions,\n  session_owner,\n  reviewed_by,\n  reviewed_at,\n  expires_at,\n  change_reason\n) values (\n  '${key}'::public.vendor_name,\n  'disabled',\n  false,\n  '${key}-disabled-scaffold.v1',\n  null,\n  null,\n  array[]::public.process_types[],\n  array[]::text[],\n  null,\n  null,\n  null,\n  null,\n  'initial_seed'\n);\n`;
}

export async function scaffoldProvider({ rootDir, url, dryRun = false }) {
  const canonicalUrl = normalizeProviderUrl(url);
  const key = deriveProviderKey(canonicalUrl);
  const domain = normalizeOfficialDomain(new URL(canonicalUrl).hostname);
  const providerDir = path.join(rootDir, "provider-integrations", key);
  const manifests = await readProviderManifests(rootDir, { allowUnreviewedEvidence: true });
  const currentKeys = new Set(await readCurrentVendorKeys(rootDir));
  const existingKey = manifests.find(({ manifest }) => manifest.key === key);

  if (existingKey) {
    const matchingDomain = existingKey.manifest.official.domains.includes(domain);
    const matchingUrl = existingKey.manifest.official.urls.some((officialUrl) =>
      normalizeProviderUrl(officialUrl) === canonicalUrl,
    );
    if (matchingDomain || matchingUrl) {
      return {
        key,
        domain,
        dryRun,
        existingVendorKey: currentKeys.has(key),
        alreadyExists: true,
        files: [],
      };
    }
    throw new Error(`provider key collision: ${key} is registered to a different official domain`);
  }
  const duplicateDomain = manifests.find(({ manifest }) => manifest.official.domains.some(
    (knownDomain) =>
      domain === knownDomain ||
      domain.endsWith(`.${knownDomain}`) ||
      knownDomain.endsWith(`.${domain}`),
  ));
  if (duplicateDomain) {
    throw new Error(`provider domain ${domain} already belongs to ${duplicateDomain.manifest.key}`);
  }
  try {
    await fs.lstat(providerDir);
    throw new Error(`provider path already exists and will not be overwritten: ${providerDir}`);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  const manifest = createProviderManifest({
    key,
    displayName: deriveDisplayName(key),
    officialUrl: canonicalUrl,
  });
  validateProviderManifest(manifest, { directoryName: key, allowUnreviewedEvidence: true });
  const files = [{ name: PROVIDER_MANIFEST_FILE, contents: formatManifest(manifest) }];
  if (!currentKeys.has(key)) {
    files.push(
      { name: ENUM_STUB, contents: enumStub(key) },
      { name: POLICY_STUB, contents: policyStub(key) },
    );
  }
  const result = {
    key,
    domain,
    dryRun,
    existingVendorKey: currentKeys.has(key),
    alreadyExists: false,
    files: files.map((file) => path.relative(rootDir, path.join(providerDir, file.name))),
  };
  if (dryRun) {
    return result;
  }

  const integrationsDir = path.dirname(providerDir);
  await fs.mkdir(integrationsDir, { recursive: true });
  const integrationsStat = await fs.lstat(integrationsDir);
  if (integrationsStat.isSymbolicLink()) {
    throw new Error("provider-integrations must not be a symlink");
  }

  const stagingDir = await fs.mkdtemp(path.join(integrationsDir, `.${key}-scaffold-`));
  try {
    for (const file of files) {
      await fs.writeFile(path.join(stagingDir, file.name), file.contents, { flag: "wx", mode: 0o644 });
    }
    await fs.chmod(stagingDir, 0o755);

    try {
      await fs.lstat(providerDir);
      throw new Error(`provider path already exists and will not be overwritten: ${providerDir}`);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    await fs.rename(stagingDir, providerDir);
  } catch (error) {
    try {
      await fs.rm(stagingDir, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `provider scaffold failed and staging cleanup also failed for ${key}`,
      );
    }
    throw error;
  }
  return result;
}

function parseArgs(argv) {
  let url;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--url") {
      url = argv[index + 1];
      index += 1;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!url) {
    throw new Error("Usage: npm run provider:add -- --url <https-url> [--dry-run]");
  }
  return { url, dryRun };
}

export async function runProviderAddCli(argv = process.argv.slice(2), rootDir = process.cwd()) {
  const result = await scaffoldProvider({ rootDir, ...parseArgs(argv) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    await runProviderAddCli();
  } catch (error) {
    process.stderr.write(`provider:add refused: ${error.message}\n`);
    process.exitCode = 1;
  }
}
