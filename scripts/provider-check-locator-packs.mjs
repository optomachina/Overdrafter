/** OVD-814: offline pack validation and deterministic worker-only bundling. */
import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { parseCodeReviewedEnvelopes, REVIEWED_ENVELOPE_SOURCE } from "./reviewed-envelope-check.mjs";

// CI runs Node 20: compile the one pure TypeScript validator with the existing
// compiler, rather than require native type stripping or maintain a second validator.
// This module has only a node:crypto import; it does not load adapters or the bundle.
const validatorSource = await fs.readFile(new URL("../worker/src/fixtureHeal/locatorPackValidation.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(validatorSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
// A data: module can resolve only built-ins; keep it that way so the check never
// evaluates anything but the validator itself.
for (const [, specifier] of outputText.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
  if (!specifier.startsWith("node:")) {
    throw new Error(`provider:check: locator pack validator may import only node: built-ins, found ${specifier}`);
  }
}
const { canonicalLocatorPackJson, locatorPackSha256, locatorPackRevisionNumber, parseLocatorPack } =
  await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
export { canonicalLocatorPackJson, locatorPackSha256 };
export const LOCATOR_PACK_BUNDLE_RELATIVE_PATH = "worker/src/generated/providerLocatorPacks.ts";
const SCHEMA_PATH = "provider-integrations/provider-locator-pack.v1.schema.json";
const fileName = /^locators\.v(0|[1-9]\d{0,5})\.json$/;
export async function readLocatorPackSchema(rootDir) {
  let schema;
  try { schema = JSON.parse(await fs.readFile(path.join(rootDir, SCHEMA_PATH), "utf8")); }
  catch { throw new Error(`provider:check: locator pack JSON schema is missing or invalid: ${SCHEMA_PATH}`); }
  if (schema.title !== "ProviderLocatorPackV1" || schema.properties?.schema?.const !== "provider-locator-pack.v1" || schema.additionalProperties !== false) throw new Error(`provider:check: locator pack JSON schema does not define the closed V1 contract: ${SCHEMA_PATH}`);
  return schema;
}
export function validateLocatorPack(pack, { provider, fileRevisionNumber, file = `provider-integrations/${provider}/locators.v${fileRevisionNumber}.json` }) {
  const parsed = parseLocatorPack(pack);
  if (!parsed.ok) throw new Error(`provider:check: ${file}: ${parsed.path}: ${parsed.reason}`);
  if (pack.provider !== provider) throw new Error(`provider:check: ${file}: provider: locator_pack_provider_mismatch`);
  if (locatorPackRevisionNumber(pack.revision) !== fileRevisionNumber) throw new Error(`provider:check: ${file}: revision: file/revision mismatch`);
  return parsed.pack;
}
/** Each provider retains all revisions, ordered numerically; only the newest is bundled. */
export async function readLocatorPacks(rootDir) {
  const base = path.join(rootDir, "provider-integrations");
  const providers = [];
  for (const dir of (await fs.readdir(base, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (!dir.isDirectory()) continue;
    const revisions = [];
    for (const entry of await fs.readdir(path.join(base, dir.name), { withFileTypes: true })) {
      if (!entry.name.startsWith("locators.")) continue;
      const file = `provider-integrations/${dir.name}/${entry.name}`;
      const match = fileName.exec(entry.name);
      if (!match || !entry.isFile()) throw new Error(`provider:check: ${file}: invalid locator pack file name or type`);
      let pack;
      try { pack = JSON.parse(await fs.readFile(path.join(rootDir, file), "utf8")); }
      catch { throw new Error(`provider:check: ${file}: invalid JSON`); }
      revisions.push({ provider: dir.name, file, fileRevisionNumber: Number(match[1]), pack });
    }
    if (revisions.length) providers.push({ provider: dir.name, revisions: revisions.sort((a, b) => a.fileRevisionNumber - b.fileRevisionNumber) });
  }
  return providers;
}
export async function assertLocatorPacks({ rootDir, manifests }) {
  const packs = await readLocatorPacks(rootDir);
  const reviewed = packs.length ? parseCodeReviewedEnvelopes(await fs.readFile(path.join(rootDir, REVIEWED_ENVELOPE_SOURCE), "utf8")) : [];
  const results = [];
  for (const { provider, revisions } of packs) {
    const manifest = manifests.map(entry => entry.manifest ?? entry).find(m => m.key === provider);
    if (!manifest) throw new Error(`provider:check: provider-integrations/${provider}: missing manifest`);
    const seen = new Set();
    const active = revisions.at(-1);
    for (const entry of revisions) {
      // Detect repeated revision identities before file-number validation.
      if (seen.has(entry.pack.revision)) throw new Error(`provider:check: ${entry.file}: duplicate revision`);
      seen.add(entry.pack.revision);
      const pack = validateLocatorPack(entry.pack, entry);
      for (const host of pack.allowedHosts) if (!manifest.official.domains.some(domain => host === domain || host.endsWith(`.${domain}`))) throw new Error(`provider:check: ${entry.file}: allowedHosts: host outside manifest domains`);
      const envelope = reviewed.find(e => e.provider === provider);
      // Only the bundled (highest) revision must bind today's reviewed envelope;
      // older revisions are history and may name the envelope they were reviewed against.
      if (entry === active && envelope && pack.envelopeRevision !== `${envelope.id}.v${envelope.version}`) throw new Error(`provider:check: ${entry.file}: envelopeRevision: locator_pack_envelope_mismatch`);
      results.push({ ...entry, revision: pack.revision, sha256: locatorPackSha256(pack), envelopeReviewed: !!envelope });
    }
  }
  return results;
}
export function renderLocatorPackBundle(packs) {
  const latest = new Map();
  for (const entry of packs) {
    const current = latest.get(entry.provider);
    if (!current || locatorPackRevisionNumber(entry.pack.revision) > locatorPackRevisionNumber(current.pack.revision)) latest.set(entry.provider, entry);
  }
  const entries = [...latest.values()].sort((a, b) => a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0)
    .map(({ provider, file, pack }) => ({ provider, file, sha256: locatorPackSha256(pack), pack }));
  return '// Generated by npm run provider:sync. Do not edit directly.\n'
    + 'export const PROVIDER_LOCATOR_PACKS: readonly { readonly provider: string; readonly file: string; readonly sha256: string; readonly pack: unknown }[] = '
    + `${JSON.stringify(JSON.parse(canonicalLocatorPackJson(entries)), null, 2)};\n`;
}
