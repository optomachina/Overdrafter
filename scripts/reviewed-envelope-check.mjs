import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

import { assertReadinessDoc } from "./provider-readiness-doc.mjs";

/**
 * Residuals this check does not close: a shadowed `const describe` binding,
 * a literal `&nbsp;` entity as readiness-section body, and an early `return;`
 * before the default-deny registrar (vitest fails that suite).
 */

export const PROVIDER_DISPATCH_ENVELOPE_DIR = "provider-dispatch-envelope";
export const PROVIDER_DISPATCH_FIXTURE_JSON_DIR = "test-fixtures/provider-dispatch-envelope";
export const PROVIDER_REGISTRY_RELATIVE_PATH = "provider-integrations/provider-registry.v1.json";
export const GENERATED_PROVIDER_REGISTRY_TS = "worker/src/generated/providerRegistry.ts";
export const GENERATED_PROVIDER_SECRETS_SH = "worker/scripts/generated/provider-secrets.sh";
export const REVIEWED_ENVELOPE_SOURCE = "worker/src/providerDispatchEnvelope.ts";
export const REVIEWED_ENVELOPE_EXPORT = "REVIEWED_PROVIDER_DISPATCH_ENVELOPES";
export const EGRESS_CONTRACT_RELATIVE_PATH = "scripts/xometry-stable-egress-contract.mjs";
export const EGRESS_OPTIONAL_ADAPTERS_EXPORT = "STABLE_EGRESS_OPTIONAL_ADAPTERS";
export const DEPLOY_SCRIPT_RELATIVE_PATH = "worker/scripts/deploy-cloud-run.sh";
export const RUNTIME_SECRETS_RELATIVE_PATH = "worker/src/runtimeSecrets.ts";
export const DEFAULT_DENY_REGISTRAR = "registerProductionPortalAuthorizationRefusals";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PROVIDER_KEY = /^[a-z][a-z0-9_]*$/;
const ENVELOPE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EVIDENCE_REFERENCE = /^OVD-([1-9]\d{0,9})$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const REGISTRY_MOUNT_PATH = /^\/var\/secrets\/[a-z0-9-]+\/storage-state\.json$/;
const EGRESS_VALUES = new Set(["stable_nat", "none"]);
const SECRET_LIKE_KEY = /^(value|token|cookie|password|secret|storagestate|storage_state)$/i;
const DEFAULT_DENY_MODULE = /(?:^|\/)test-support\/productionPortalDefaultDeny(?:\.js|\.ts)?$/;
const DISPATCH_FIXTURE_HELPER_MODULE = /^\.\/providerDispatchFixture(?:\.js|\.ts)?$/;

/**
 * Every reviewed provider must carry its own artifacts at paths derived only
 * from its provider key and reviewed envelope metadata. No artifact of one
 * provider can satisfy another provider by mentioning its key.
 */
export const REVIEWED_ENVELOPE_ARTIFACTS = Object.freeze({
  readinessDoc: {
    artifact: "readiness doc",
    expectedPath: (key, envelope) => readinessDocPaths(key, envelope).at(-1),
  },
  dispatchFixture: {
    artifact: "dispatch fixture",
    expectedPath: (key) => `worker/test-support/${key}DispatchFixture.ts`,
  },
  defaultDenyTest: {
    artifact: "productionPortalDefaultDeny test",
    expectedPath: (key) => `worker/src/adapters/${key}ProductionPortal.test.ts`,
  },
  deployWiring: {
    artifact: "deploy wiring",
    expectedPath: () => PROVIDER_REGISTRY_RELATIVE_PATH,
  },
});

/**
 * Temporary dated exceptions for hand-built providers that are already
 * reviewed on main but are not yet on the kit-shaped default-deny harness.
 * After expiresOn the gap fails. Do not extend without a tracking issue.
 */
export const REVIEWED_ENVELOPE_EXCEPTIONS = Object.freeze([
  {
    key: "fictiv",
    artifact: REVIEWED_ENVELOPE_ARTIFACTS.defaultDenyTest.artifact,
    issue: "OVD-673",
    expiresOn: "2026-12-31",
  },
]);

export function formatReviewedEnvelopeGap(key, artifact, expectedPath) {
  return `provider:check: ${key} reviewed envelope missing ${artifact} (expected ${expectedPath}); run npm run provider:onboard -- ${key} --stage=live`;
}

export function dispatchFixtureJsonPath(key, version) {
  return `${PROVIDER_DISPATCH_FIXTURE_JSON_DIR}/${key}-v${version}.json`;
}

/**
 * Deterministic readiness doc candidates: `<key>-live-readiness.md`, or
 * `ovd<N>-<key>-live-readiness.md` when the envelope's own fixture names
 * evidence reference OVD-<N>. The last entry is the preferred path.
 */
export function readinessDocPaths(key, envelope) {
  const paths = [`docs/workflows/${key}-live-readiness.md`];
  const match = EVIDENCE_REFERENCE.exec(envelope?.evidenceReference ?? "");
  if (match) {
    paths.push(`docs/workflows/ovd${match[1]}-${key}-live-readiness.md`);
  }
  return paths;
}

export function isReviewedEnvelopeDocument(document) {
  if (!isPlainObject(document)) {
    return false;
  }
  const review = isPlainObject(document.review) ? document.review : document;
  const reviewer = firstNonEmptyString(review.reviewer, review.reviewedBy, document.reviewer, document.reviewedBy);
  const reviewedAt = firstNonEmptyString(review.reviewedAt, review.date, document.reviewedAt);
  return Boolean(reviewer && ISO_DATE.test(reviewedAt));
}

export function providerKeyFromEnvelopeDocument(document, fallbackName = "") {
  if (isPlainObject(document)) {
    const nested = isPlainObject(document.envelope) ? document.envelope : null;
    const key = firstNonEmptyString(document.provider, document.key, nested?.provider);
    if (key && PROVIDER_KEY.test(key)) {
      return key;
    }
  }
  const fromName = fallbackName.replace(/\.json$/i, "").replace(/-v\d+$/i, "");
  return PROVIDER_KEY.test(fromName) ? fromName : null;
}

export function isActiveReviewedEnvelopeException(exception, today) {
  return Boolean(
    exception
    && ISO_DATE.test(today)
    && ISO_DATE.test(exception.expiresOn)
    && today <= exception.expiresOn,
  );
}

/**
 * Parses the reviewed envelope registry with the TypeScript compiler, so
 * quoting, whitespace, comments, property order, and `as const` / `satisfies`
 * wrappers do not change which providers are found. Anything that cannot be
 * resolved statically fails closed.
 */
export function parseCodeReviewedEnvelopes(source, fileName = REVIEWED_ENVELOPE_SOURCE) {
  assertEnvelopeSourceParses(source, fileName);
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const initializer = findTopLevelConstInitializer(sourceFile, REVIEWED_ENVELOPE_EXPORT);
  if (!initializer) {
    throw new Error(`provider:check: ${fileName} does not declare ${REVIEWED_ENVELOPE_EXPORT}`);
  }
  const array = unwrapExpression(initializer);
  if (!ts.isArrayLiteralExpression(array)) {
    throw new Error(`provider:check: ${REVIEWED_ENVELOPE_EXPORT} must be an array literal`);
  }
  return array.elements.map((element, index) => {
    const object = unwrapExpression(element);
    if (!ts.isObjectLiteralExpression(object)) {
      throw new Error(`provider:check: ${REVIEWED_ENVELOPE_EXPORT}[${index}] must be an object literal`);
    }
    const read = (name) => resolveStaticValue(sourceFile, objectProperty(object, name));
    const entry = {
      provider: read("provider"),
      id: read("id"),
      version: read("version"),
      requiredAdmission: read("requiredAdmission"),
    };
    if (
      !PROVIDER_KEY.test(entry.provider ?? "")
      || !ENVELOPE_ID.test(entry.id ?? "")
      || !Number.isSafeInteger(entry.version)
      || typeof entry.requiredAdmission !== "string"
    ) {
      throw new Error(`provider:check: ${REVIEWED_ENVELOPE_EXPORT}[${index}] is not statically resolvable`);
    }
    return entry;
  });
}

/** Fails closed on syntax errors so a broken registry never reads as "no envelopes". */
function assertEnvelopeSourceParses(source, fileName) {
  const { diagnostics = [] } = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.Latest },
  });
  const first = diagnostics.find((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (first) {
    throw new Error(
      `provider:check: cannot read reviewed envelopes from ${fileName}: ${ts.flattenDiagnosticMessageText(first.messageText, " ")}`,
    );
  }
}

export function parseCodeReviewedGenericProviders(source) {
  const keys = parseCodeReviewedEnvelopes(source)
    .filter((entry) => entry.requiredAdmission === "generic_dispatch")
    .map((entry) => entry.provider);
  return [...new Set(keys)];
}

export async function collectReviewedEnvelopeGaps({
  rootDir,
  today = new Date().toISOString().slice(0, 10),
  exceptions = REVIEWED_ENVELOPE_EXCEPTIONS,
}) {
  const reviewed = await readReviewedEnvelopes(rootDir);
  const missingByProvider = await Promise.all(
    reviewed.map((envelope) => missingArtifactsForProvider(rootDir, envelope)),
  );
  return missingByProvider.flat().filter((item) => !isExcepted(exceptions, item.key, item.artifact, today));
}

export async function assertReviewedEnvelopeCompleteness(options) {
  const gaps = await collectReviewedEnvelopeGaps(options);
  if (gaps.length > 0) {
    throw new Error(gaps.map((gap) => formatReviewedEnvelopeGap(gap.key, gap.artifact, gap.expectedPath)).join("\n"));
  }
  const reviewed = await readReviewedEnvelopes(options.rootDir);
  return { reviewedProviders: reviewed.map((envelope) => envelope.key) };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function compareStrings(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function isExcepted(exceptions, key, artifact, today) {
  return exceptions.some((exception) => (
    exception.key === key
    && exception.artifact === artifact
    && isActiveReviewedEnvelopeException(exception, today)
  ));
}

function containsEnvName(text, name) {
  return new RegExp(`(?<![A-Z0-9_])${name}(?![A-Z0-9_])`).test(text);
}

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

async function readTextIfPresent(targetPath) {
  const stat = await lstatIfPresent(targetPath);
  if (!stat) {
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`reviewed-envelope input must be a regular file: ${targetPath}`);
  }
  return fs.readFile(targetPath, "utf8");
}

async function readJsonIfPresent(targetPath) {
  const text = await readTextIfPresent(targetPath);
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`reviewed-envelope JSON is invalid: ${targetPath}`);
  }
}

// ---------------------------------------------------------------------------
// Reviewed envelope discovery
// ---------------------------------------------------------------------------

async function readReviewedEnvelopes(rootDir) {
  const byKey = new Map();
  const add = (envelope, source) => {
    const existing = byKey.get(envelope.key);
    if (existing && (existing.id !== envelope.id || existing.version !== envelope.version)) {
      throw new Error(`provider:check: ${envelope.key} has conflicting reviewed envelopes in ${existing.source} and ${source}`);
    }
    byKey.set(envelope.key, existing ?? { ...envelope, source });
  };

  let envelopeSource;
  try {
    envelopeSource = await readTextIfPresent(path.join(rootDir, REVIEWED_ENVELOPE_SOURCE));
  } catch (error) {
    throw new Error(`provider:check: cannot read reviewed envelopes from ${REVIEWED_ENVELOPE_SOURCE}: ${error.message}`);
  }
  if (envelopeSource === null) {
    throw new Error(`provider:check: cannot read reviewed envelopes from ${REVIEWED_ENVELOPE_SOURCE}: file is missing`);
  }
  for (const entry of parseCodeReviewedEnvelopes(envelopeSource)) {
    if (entry.requiredAdmission === "generic_dispatch") {
      add({ key: entry.provider, id: entry.id, version: entry.version }, REVIEWED_ENVELOPE_SOURCE);
    }
  }
  for (const { name, envelope } of await readReviewedEnvelopeDocuments(rootDir)) {
    add(envelope, `${PROVIDER_DISPATCH_ENVELOPE_DIR}/${name}`);
  }

  const envelopes = [...byKey.values()].sort((left, right) => compareStrings(left.key, right.key));
  return Promise.all(envelopes.map(async (envelope) => ({
    ...envelope,
    fixture: await readEnvelopeFixtureJson(rootDir, envelope),
  })));
}

async function readReviewedEnvelopeDocuments(rootDir) {
  const envelopeDir = path.join(rootDir, PROVIDER_DISPATCH_ENVELOPE_DIR);
  const dirStat = await lstatIfPresent(envelopeDir);
  if (!dirStat) {
    return [];
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error(`${PROVIDER_DISPATCH_ENVELOPE_DIR} must be a real directory`);
  }
  const entries = await fs.readdir(envelopeDir, { withFileTypes: true });
  const documents = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map(async (entry) => ({
      name: entry.name,
      document: await readJsonIfPresent(path.join(envelopeDir, entry.name)),
    })));
  const reviewed = [];
  for (const { name, document } of documents) {
    if (!isReviewedEnvelopeDocument(document)) {
      continue;
    }
    const key = providerKeyFromEnvelopeDocument(document, name);
    if (!key) {
      throw new Error(`reviewed envelope ${name} does not name a provider key`);
    }
    const revision = document.envelope?.envelope;
    if (!isPlainObject(revision) || !ENVELOPE_ID.test(revision.id ?? "") || !Number.isSafeInteger(revision.version)) {
      throw new Error(`reviewed envelope ${name} does not name an envelope id and version`);
    }
    reviewed.push({ name, envelope: { key, id: revision.id, version: revision.version } });
  }
  return reviewed;
}

/**
 * The provider's own synthetic envelope JSON. It must bind exactly this
 * provider, envelope id, and version; otherwise it is treated as absent.
 */
async function readEnvelopeFixtureJson(rootDir, { key, id, version }) {
  const document = await readJsonIfPresent(path.join(rootDir, dispatchFixtureJsonPath(key, version)));
  const envelope = document?.envelope;
  if (
    !isPlainObject(envelope)
    || envelope.provider !== key
    || envelope.envelope?.id !== id
    || envelope.envelope?.version !== version
  ) {
    return null;
  }
  const evidenceReference = envelope.admission?.evidenceReference;
  return { evidenceReference: typeof evidenceReference === "string" ? evidenceReference : null };
}

// ---------------------------------------------------------------------------
// Per-provider artifacts
// ---------------------------------------------------------------------------

async function missingArtifactsForProvider(rootDir, envelope) {
  const checks = [
    ["readinessDoc", hasReadinessDoc],
    ["dispatchFixture", hasDispatchFixture],
    ["defaultDenyTest", hasDefaultDenyTest],
    ["deployWiring", hasDeployWiring],
  ];
  const results = await Promise.all(checks.map(([, check]) => check(rootDir, envelope)));
  return checks
    .filter((_, index) => !results[index])
    .map(([artifactId]) => gap(envelope, artifactId));
}

function gap(envelope, artifactId) {
  const spec = REVIEWED_ENVELOPE_ARTIFACTS[artifactId];
  return {
    key: envelope.key,
    artifact: spec.artifact,
    expectedPath: spec.expectedPath(envelope.key, envelope.fixture),
  };
}

async function hasReadinessDoc(rootDir, envelope) {
  const paths = readinessDocPaths(envelope.key, envelope.fixture);
  const contents = await Promise.all(paths.map((relative) => readTextIfPresent(path.join(rootDir, relative))));
  const index = contents.findIndex((text) => text !== null && text.trim().length > 0);
  if (index === -1) {
    return false;
  }
  assertReadinessDoc(contents[index], paths[index]);
  return true;
}

/**
 * `worker/test-support/<key>DispatchFixture.ts` must import this provider's
 * own envelope JSON (`test-fixtures/provider-dispatch-envelope/<key>-v<N>.json`)
 * and the shared fixture helper. Imports are read from the TypeScript AST.
 */
async function hasDispatchFixture(rootDir, envelope) {
  if (!envelope.fixture) {
    return false;
  }
  const relative = REVIEWED_ENVELOPE_ARTIFACTS.dispatchFixture.expectedPath(envelope.key);
  const source = await readTextIfPresent(path.join(rootDir, relative));
  if (source === null) {
    return false;
  }
  const sourceFile = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers = importDeclarations(sourceFile).map((declaration) => declaration.moduleSpecifier.text);
  const ownJson = `../../${dispatchFixtureJsonPath(envelope.key, envelope.version)}`;
  return specifiers.includes(ownJson) && specifiers.some((specifier) => DISPATCH_FIXTURE_HELPER_MODULE.test(specifier));
}

/**
 * `worker/src/adapters/<key>ProductionPortal.test.ts` must import the shared
 * default-deny registrar and call it with a harness whose `vendor` is this
 * provider and whose `envelopeId` is this provider's reviewed envelope id.
 */
async function hasDefaultDenyTest(rootDir, envelope) {
  const relative = REVIEWED_ENVELOPE_ARTIFACTS.defaultDenyTest.expectedPath(envelope.key);
  const source = await readTextIfPresent(path.join(rootDir, relative));
  if (source === null) {
    return false;
  }
  const sourceFile = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const localNames = new Set();
  for (const declaration of importDeclarations(sourceFile)) {
    if (!DEFAULT_DENY_MODULE.test(declaration.moduleSpecifier.text)) {
      continue;
    }
    const bindings = declaration.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName ?? element.name).text === DEFAULT_DENY_REGISTRAR) {
          localNames.add(element.name.text);
        }
      }
    }
  }
  if (localNames.size === 0) {
    return false;
  }
  const calls = findNodes(sourceFile, ts.isCallExpression).filter((call) => (
    ts.isIdentifier(call.expression)
    && localNames.has(call.expression.text)
    && call.arguments.length === 1
    && harnessBindsEnvelope(sourceFile, call.arguments[0], envelope)
  ));
  const violations = [];
  for (const call of calls) {
    const violation = unconditionalPlacementViolation(call);
    if (violation === null) {
      return true;
    }
    violations.push(violation);
  }
  if (violations.length > 0) {
    throw new Error(
      `provider:check: ${envelope.key} default-deny registrar call in ${relative} is not unconditional (inside ${violations[0]}); `
      + "call it at the top level or directly in a describe block",
    );
  }
  return false;
}

/**
 * Default-deny: the call must be an expression statement whose ancestors are
 * only the SourceFile and plain `describe` callback bodies. Returns null
 * when allowed, otherwise the SyntaxKind name of the first offending node.
 */
function unconditionalPlacementViolation(call) {
  let node = call;
  for (;;) {
    const statement = node.parent;
    if (!statement || !ts.isExpressionStatement(statement) || statement.expression !== node) {
      return kindName(statement);
    }
    const container = statement.parent;
    if (ts.isSourceFile(container)) {
      return null;
    }
    if (!ts.isBlock(container)) {
      return kindName(container);
    }
    const fn = container.parent;
    if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) || fn.body !== container) {
      return kindName(fn ?? container);
    }
    const describeCall = fn.parent;
    if (
      !describeCall
      || !ts.isCallExpression(describeCall)
      || !describeCall.arguments.includes(fn)
      || !isAllowedDescribeCallee(describeCall.expression)
    ) {
      return kindName(fn);
    }
    node = describeCall;
  }
}

/**
 * Default-deny may sit in a plain `describe` only. `describe.each`,
 * `describe.skip`, `.todo`, `.skipIf`, `.only`, and similar wrappers do not
 * count — an empty `describe.each([])` would otherwise drop the suite.
 */
function isAllowedDescribeCallee(expression) {
  return ts.isIdentifier(expression) && expression.text === "describe";
}

function kindName(node) {
  return node ? ts.SyntaxKind[node.kind] : "unknown";
}

function harnessBindsEnvelope(sourceFile, argument, envelope) {
  const harness = resolveHarnessObject(sourceFile, argument, new Set());
  if (!harness) {
    return false;
  }
  return resolveStaticValue(sourceFile, objectProperty(harness, "vendor")) === envelope.key
    && resolveStaticValue(sourceFile, objectProperty(harness, "envelopeId")) === envelope.id;
}

async function hasDeployWiring(rootDir, { key }) {
  const registry = await readJsonIfPresent(path.join(rootDir, PROVIDER_REGISTRY_RELATIVE_PATH));
  if (registry !== null) {
    return registryDeclaresProvider(registry, key, rootDir);
  }
  return fallbackDeployWiringDeclaresProvider(rootDir, key);
}

async function registryDeclaresProvider(registry, key, rootDir) {
  const entries = Array.isArray(registry) ? registry : registry.providers;
  if (!Array.isArray(entries)) {
    return false;
  }
  const entry = entries.find((candidate) => candidate && candidate.key === key);
  if (!isPlainObject(entry)) {
    return false;
  }
  assertRegistryNamesOnly(entry, key);
  if (!Array.isArray(entry.sessionSecrets) || !EGRESS_VALUES.has(entry.egress)) {
    return false;
  }
  const secretNames = [];
  for (const secret of entry.sessionSecrets) {
    if (!isPlainObject(secret)) {
      return false;
    }
    assertRegistryNamesOnly(secret, key);
    if (!ENV_NAME.test(secret.secretNameEnv ?? "")) {
      return false;
    }
    secretNames.push(secret.secretNameEnv);
    const hasMountEnv = typeof secret.mountEnv === "string";
    const hasMountPath = typeof secret.mountPath === "string";
    if (hasMountEnv === hasMountPath) {
      return false;
    }
    if (hasMountEnv && !ENV_NAME.test(secret.mountEnv)) {
      return false;
    }
    if (hasMountPath && !REGISTRY_MOUNT_PATH.test(secret.mountPath)) {
      return false;
    }
    if (hasMountEnv) {
      secretNames.push(secret.mountEnv);
    }
  }
  return generatedMappingsContainNames(rootDir, secretNames);
}

async function generatedMappingsContainNames(rootDir, secretNames) {
  if (secretNames.length === 0) {
    return true;
  }
  const generated = [
    await readTextIfPresent(path.join(rootDir, GENERATED_PROVIDER_REGISTRY_TS)),
    await readTextIfPresent(path.join(rootDir, GENERATED_PROVIDER_SECRETS_SH)),
  ];
  const present = generated.filter((text) => text !== null);
  if (present.length === 0) {
    return true;
  }
  return present.every((text) => secretNames.every((name) => containsEnvName(text, name)));
}

async function fallbackDeployWiringDeclaresProvider(rootDir, key) {
  const envPrefix = key.toUpperCase();
  const secretName = `${envPrefix}_STORAGE_STATE_SECRET_NAME`;
  const mountNames = [
    `${envPrefix}_STORAGE_STATE_JSON`,
    `${envPrefix}_STORAGE_STATE_MOUNT_PATH`,
  ];
  const deploy = await readTextIfPresent(path.join(rootDir, DEPLOY_SCRIPT_RELATIVE_PATH));
  const runtime = await readTextIfPresent(path.join(rootDir, RUNTIME_SECRETS_RELATIVE_PATH));
  const egress = await readTextIfPresent(path.join(rootDir, EGRESS_CONTRACT_RELATIVE_PATH));
  const sources = [deploy, runtime].filter((text) => text !== null);
  if (sources.length === 0 || egress === null) {
    return false;
  }
  const secretDeclared = sources.some((text) => containsEnvName(text, secretName));
  const mountDeclared = sources.some((text) => mountNames.some((name) => containsEnvName(text, name)));
  return secretDeclared && mountDeclared && parseEgressOptionalAdapters(egress).includes(key);
}

/** Reads STABLE_EGRESS_OPTIONAL_ADAPTERS from the egress contract's AST. */
export function parseEgressOptionalAdapters(source) {
  const sourceFile = ts.createSourceFile(
    EGRESS_CONTRACT_RELATIVE_PATH,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const initializer = findTopLevelConstInitializer(sourceFile, EGRESS_OPTIONAL_ADAPTERS_EXPORT);
  const array = initializer ? unwrapExpression(initializer) : null;
  if (!array || !ts.isArrayLiteralExpression(array)) {
    return [];
  }
  return array.elements
    .map((element) => resolveStaticValue(sourceFile, element))
    .filter((value) => typeof value === "string");
}

function assertRegistryNamesOnly(value, key) {
  if (!isPlainObject(value)) {
    return;
  }
  for (const [field, fieldValue] of Object.entries(value)) {
    if (field === "mountPath" && typeof fieldValue === "string" && REGISTRY_MOUNT_PATH.test(fieldValue)) {
      continue;
    }
    if (SECRET_LIKE_KEY.test(field) || (typeof fieldValue === "string" && looksLikeSecretValue(fieldValue))) {
      throw new Error(`provider:check: ${key} registry entry must declare secret names only`);
    }
    if (fieldValue && typeof fieldValue === "object") {
      assertRegistryNamesOnly(fieldValue, key);
    }
  }
}

function looksLikeSecretValue(value) {
  if (ENV_NAME.test(value) || EGRESS_VALUES.has(value) || PROVIDER_KEY.test(value)) {
    return false;
  }
  return value.length >= 40;
}

// ---------------------------------------------------------------------------
// TypeScript AST helpers (static, same-file resolution only)
// ---------------------------------------------------------------------------

function importDeclarations(sourceFile) {
  return sourceFile.statements.filter((statement) => (
    ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
  ));
}

function findNodes(root, predicate) {
  const found = [];
  const visit = (node) => {
    if (predicate(node)) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function findTopLevelConstInitializer(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
        return declaration.initializer;
      }
    }
  }
  return null;
}

function findTopLevelFunctionReturn(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body) {
      return singleReturnExpression(statement.body);
    }
  }
  const initializer = findTopLevelConstInitializer(sourceFile, name);
  const fn = initializer ? unwrapExpression(initializer) : null;
  if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
    return ts.isBlock(fn.body) ? singleReturnExpression(fn.body) : fn.body;
  }
  return null;
}

function singleReturnExpression(block) {
  const returns = block.statements.filter(ts.isReturnStatement);
  return returns.length === 1 ? returns[0].expression ?? null : null;
}

/** Strips parentheses, `as`, `satisfies`, `!`, type assertions, and `Object.freeze(...)`. */
function unwrapExpression(node) {
  let current = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current)
      || ts.isAsExpression(current)
      || ts.isNonNullExpression(current)
      || ts.isTypeAssertionExpression(current)
      || (ts.isSatisfiesExpression?.(current) ?? false)
    ) {
      current = current.expression;
    } else if (isObjectFreezeCall(current)) {
      current = current.arguments[0];
    } else {
      return current;
    }
  }
}

function isObjectFreezeCall(node) {
  return ts.isCallExpression(node)
    && node.arguments.length === 1
    && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression)
    && node.expression.expression.text === "Object"
    && node.expression.name.text === "freeze";
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    const inner = unwrapExpression(name.expression);
    if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) {
      return inner.text;
    }
  }
  return null;
}

/** Returns the value node of a property, or null when absent or ambiguous. */
function objectProperty(object, name) {
  const matches = [];
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      return null;
    }
    if (property.name && propertyNameText(property.name) === name) {
      matches.push(property);
    }
  }
  if (matches.length !== 1) {
    return null;
  }
  const [property] = matches;
  if (ts.isPropertyAssignment(property)) {
    return property.initializer;
  }
  if (ts.isShorthandPropertyAssignment(property)) {
    return property.name;
  }
  return null;
}

function resolveStaticValue(sourceFile, node, seen = new Set()) {
  if (!node) {
    return undefined;
  }
  const expression = unwrapExpression(node);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (ts.isNumericLiteral(expression)) {
    return Number(expression.text);
  }
  if (ts.isIdentifier(expression)) {
    if (seen.has(expression.text)) {
      return undefined;
    }
    seen.add(expression.text);
    return resolveStaticValue(sourceFile, findTopLevelConstInitializer(sourceFile, expression.text), seen);
  }
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    const target = findTopLevelConstInitializer(sourceFile, expression.expression.text);
    const object = target ? unwrapExpression(target) : null;
    if (object && ts.isObjectLiteralExpression(object)) {
      return resolveStaticValue(sourceFile, objectProperty(object, expression.name.text), seen);
    }
  }
  return undefined;
}

function resolveHarnessObject(sourceFile, node, seen) {
  const expression = unwrapExpression(node);
  if (ts.isObjectLiteralExpression(expression)) {
    return expression;
  }
  const name = ts.isIdentifier(expression)
    ? expression.text
    : ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && expression.arguments.length === 0
      ? expression.expression.text
      : null;
  if (!name || seen.has(name)) {
    return null;
  }
  seen.add(name);
  const next = ts.isIdentifier(expression)
    ? findTopLevelConstInitializer(sourceFile, name)
    : findTopLevelFunctionReturn(sourceFile, name);
  return next ? resolveHarnessObject(sourceFile, next, seen) : null;
}
