/**
 * Bind the OVD-510 pre-change compatibility matrix to one retained disposable
 * replay and to the current source's finite RPC call paths. This reads only
 * local synthetic fixture files and source; it never connects to a database.
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const compareNames = (a, b) => a.localeCompare(b);
const fixturePath = process.cwd();
if (process.argv.length !== 2
    || dirname(fixturePath) !== join(root, "output")
    || !/^ovd510-replay-[0-9a-f]{8}$/.test(basename(fixturePath))
    || !lstatSync(fixturePath).isDirectory()) {
  throw new Error("fixture_directory_not_owned_local_directory");
}
const outputPath = join(fixturePath, "compatibility-manifest.json");
const existingOutput = lstatSync(outputPath, { throwIfNoEntry: false });
if (existingOutput && !existingOutput.isFile()) {
  throw new Error("manifest_output_not_regular_file");
}
const read = (name) => {
  const path = join(fixturePath, name);
  if (!lstatSync(path).isFile()) throw new Error(`fixture_input_not_regular_file:${name}`);
  return JSON.parse(readFileSync(path, "utf8"));
};
const sha = (value) => createHash("sha256").update(value).digest("hex");
const result = read("result.json");
const fixture = read("manifest.json");
const catalog = read("catalog.json");
const expectedCleanup = ["authSource", "container", "network", "storageSource"];
if (result.status !== "passed" || result.fixtureId !== fixture.fixtureId
    || result.sourceRevision !== fixture.sourceRevision
    || result.catalogSha256 !== sha(JSON.stringify(catalog))
    || !result.cleanup
    || Object.keys(result.cleanup).toSorted(compareNames).join(",") !== expectedCleanup.toSorted(compareNames).join(",")
    || expectedCleanup.some((key) => result.cleanup[key] !== "removed_owned")) {
  throw new Error("fixture_result_or_cleanup_mismatch");
}
const currentMigrations = readdirSync(join(root, "supabase", "migrations"))
  .filter((name) => /^\d+_.+\.sql$/.test(name)).sort(compareNames);
const replayedMigrations = fixture.manifest.map((entry) => entry.name).sort(compareNames);
if (currentMigrations.join("|") !== replayedMigrations.join("|")) {
  throw new Error("migration_filename_set_drift");
}
for (const entry of fixture.manifest) {
  const current = sha(readFileSync(join(root, "supabase", "migrations", entry.name)));
  if (current !== entry.sha256) throw new Error(`migration_drift:${entry.name}`);
}
if (fixture.manifest.length !== 148 || catalog.functions.length !== 452
    || catalog.schemas.length !== 10 || catalog.policies.length !== 132
    || catalog.relations.length !== 158 || !Array.isArray(catalog.sequences)
    || result.sequenceCount !== catalog.sequences.length
    || !catalog.roles.some((role) => role.rolname === "dashboard_user")
    || catalog.functions.some((f) => !Object.hasOwn(f.callers, "dashboard_user"))
    || catalog.schemas.some((schema) => typeof schema.public_usage !== "boolean")
    || catalog.functions.some((f) => !Array.isArray(f.explicit_grants)
      || (f.acl === null && f.explicit_grants.length !== 0))) {
  throw new Error("catalog_shape_mismatch");
}
const ownerSet = new Set(catalog.functions
  .filter((f) => ["public", "engineering_private", "storage"].includes(f.schema_name) && !f.extension_owned)
  .map((f) => f.owner));
if ([...ownerSet].sort(compareNames).join(",") !== "postgres,supabase_storage_admin") {
  throw new Error("target_owner_drift");
}

const refs = [];
const dynamic = [];
function scanFile(file) {
  const source = readFileSync(file, "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      let method = "";
      if (ts.isPropertyAccessExpression(expression)) method = expression.name.text;
      else if (ts.isIdentifier(expression)) method = expression.text;
      if (["rpc", "callRpc", "callUntypedRpc"].includes(method)) {
        const arg = node.arguments[0];
        const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
        const site = { file: relative(root, file), line, method };
        if (arg && ts.isStringLiteralLike(arg)) refs.push({ ...site, name: arg.text });
        else dynamic.push({ ...site, expression: arg?.getText(tree) ?? "" });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
}
function scanDir(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) scanDir(path);
    else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) scanFile(path);
  }
}
for (const dir of ["src", "supabase/functions", "worker/src"]) scanDir(join(root, dir));
const expectedDynamic = [
  "src/features/quotes/api/shared/rpc.ts:fn",
  "src/features/quotes/api/shared/rpc.ts:fn",
  "supabase/functions/engineering-interpretation/index.ts:name",
  "supabase/functions/engineering-worker/index.ts:name",
  "supabase/functions/engineering-worker/index.ts:call.name",
  "supabase/functions/engineering-worker-task/index.ts:name",
  "supabase/functions/engineering-worker-task/index.ts:call.name",
  "worker/src/providerCapabilityCanaryLedger.ts:name",
  "worker/src/providerCapabilityPersistenceTransport.ts:requested",
  "worker/src/providerCapabilityPreparationPersistence.ts:rpc",
  "worker/src/providerCapabilityPreparationTransport.ts:requested",
  "worker/src/providerCapabilityRuntimePersistence.ts:name",
  "worker/src/providerDispatchPreflight.ts:PREFLIGHT_RPC",
];
if (dynamic.map((d) => `${d.file}:${d.expression}`).toSorted(compareNames).join("|")
    !== expectedDynamic.toSorted(compareNames).join("|")) {
  throw new Error(`unresolved_dynamic_rpc_site:${JSON.stringify(dynamic)}`);
}
const byName = new Map();
for (const f of catalog.functions) {
  const found = byName.get(f.function_name) ?? [];
  found.push(f);
  byName.set(f.function_name, found);
}
// Application callers of RPCs that only a staged window 2 file creates. They
// resolve in no prechange catalog; each must name the staged file that creates
// exactly that public function, and nothing else may be missing.
const stagedOnlyRpcs = new Map([
  ["api_read_native_step_review", "docs/release/ovd-563-step-review-forward.sql"],
  ["api_configure_stripe_catalog_price", "docs/migration-drafts/ovd-725-stripe-catalog.sql"],
  ["api_disable_stripe_catalog_price", "docs/migration-drafts/ovd-725-stripe-catalog.sql"],
]);
const literalCallers = refs.map((ref) => {
  const matches = byName.get(ref.name) ?? [];
  if (matches.length === 0 && stagedOnlyRpcs.has(ref.name)) {
    const stagedPath = stagedOnlyRpcs.get(ref.name);
    if (!readFileSync(join(root, stagedPath), "utf8").includes(`create function public.${ref.name}(`)) {
      throw new Error(`staged_only_rpc_source_missing:${ref.name}`);
    }
    return { ...ref, exactIdentity: null, stagedSource: stagedPath };
  }
  if (matches.length !== 1 || matches[0].schema_name !== "public") {
    throw new Error(`ambiguous_or_missing_rpc:${ref.file}:${ref.line}:${ref.name}`);
  }
  const f = matches[0];
  return { ...ref, exactIdentity: `public.${f.function_name}(${f.identity_arguments})`, definitionMd5: f.definition_md5 };
}).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
for (const name of ["api_consume_worker_pairing", "api_register_worker_boot", "api_worker_session_eligibility"]) {
  if (literalCallers.some((r) => r.name === name)) {
    throw new Error(`gateway_dispatch_shape_changed:${name}`);
  }
  const matches = byName.get(name) ?? [];
  if (matches.length !== 1 || matches[0].schema_name !== "public") throw new Error(`gateway_rpc_missing:${name}`);
}
const gatewayCalls = ["api_consume_worker_pairing", "api_register_worker_boot", "api_worker_session_eligibility"]
  .map((name) => {
    const f = byName.get(name)[0];
    return { name, exactIdentity: `public.${f.function_name}(${f.identity_arguments})`, definitionMd5: f.definition_md5 };
  });
const gatewaySource = readFileSync(join(root, "supabase/functions/engineering-worker/index.ts"), "utf8");
const gatewayTree = ts.createSourceFile("engineering-worker/index.ts", gatewaySource, ts.ScriptTarget.Latest, true);
const rpcAlias = gatewayTree.statements.find((node) => ts.isTypeAliasDeclaration(node) && node.name.text === "RpcName");
if (!rpcAlias || !ts.isUnionTypeNode(rpcAlias.type)) throw new Error("gateway_rpc_union_missing");
const declaredGatewayNames = rpcAlias.type.types.map((node) => {
  if (!ts.isLiteralTypeNode(node) || !ts.isStringLiteralLike(node.literal)) throw new Error("gateway_rpc_union_nonliteral");
  return node.literal.text;
}).sort(compareNames);
if (declaredGatewayNames.join(",") !== gatewayCalls.map((call) => call.name).sort(compareNames).join(",")) {
  throw new Error("gateway_rpc_union_drift");
}
const operation = gatewayTree.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "operation");
if (!operation) throw new Error("gateway_operation_missing");
const returnedNames = [];
function inspectOperation(node) {
  if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
    const name = node.expression.properties.find((property) =>
      ts.isPropertyAssignment(property) && property.name.getText(gatewayTree) === "name");
    if (name && ts.isStringLiteralLike(name.initializer)) returnedNames.push(name.initializer.text);
  }
  ts.forEachChild(node, inspectOperation);
}
inspectOperation(operation);
if (returnedNames.toSorted(compareNames).join(",") !== declaredGatewayNames.join(",")) {
  throw new Error("gateway_operation_dispatch_drift");
}
// Deliberate caller or dispatch changes require a reviewed new baseline. A
// regenerated catalog alone cannot approve a newly named application RPC.
const callerResolutionSha256 = sha(JSON.stringify({ literalCallers, dynamicSites: dynamic, gatewayCalls }));
// Window 2 rebaseline (OVD-743): 148 migration production equal baseline, nine
// new dynamic sites reviewed below in dynamicRules, three staged only callers.
if (callerResolutionSha256 !== "65941b4598dd28bcfaa3a7e3d384e229664bd10aef916f492700735c9898e015") {
  throw new Error(`reviewed_rpc_caller_set_drift:${callerResolutionSha256}`);
}
const dispatchSourceSha256 = {
  "src/features/quotes/api/shared/rpc.ts": "14b3271b0d24f35c70a7f9db950f41905a3e5620449263c25fd6a187f76d56aa",
  "supabase/functions/engineering-worker/index.ts": "7fae7eba5e9d5c8f06ed1a7b6649e20c2759d5d4ae524e5863e8680fb47be2fb",
};
for (const [path, expected] of Object.entries(dispatchSourceSha256)) {
  if (sha(readFileSync(join(root, path))) !== expected) throw new Error(`reviewed_dispatch_source_drift:${path}:${sha(readFileSync(join(root, path)))}`);
}
const manifest = {
  version: 1,
  scope: "synthetic_disposable_source_only_prechange",
  fixture: {
    id: fixture.fixtureId, sourceRevision: fixture.sourceRevision,
    catalogSha256: result.catalogSha256, runnerSha256: fixture.runnerSha256,
    databaseVersion: catalog.databaseVersion,
    postgresImageId: fixture.imageId, authImageId: fixture.authImageId,
    storageImageId: fixture.storageImageId,
    migrationCount: fixture.manifest.length,
    migrationManifestSha256: sha(JSON.stringify(fixture.manifest)),
  },
  callerResolution: {
    reviewedSha256: callerResolutionSha256,
    dispatchSourceSha256,
    literalCallers,
    dynamicSites: dynamic,
    dynamicRules: [
      "Both browser wrapper parameters are called only with literal names in scanned source.",
      "Engineering worker serverRpc accepts a three-name RpcName union returned by operation().",
      "The runtime.rpc(call.name) test seam forwards only the same operation() union.",
      "engineering-interpretation serverRpc accepts only its three-name RpcName union.",
      "engineering-worker-task serverRpc and runtime.rpc(call.name) accept only its three-name Rpc union returned by rpcFor().",
      "providerCapabilityCanaryLedger forwards only the literal api_record_capability_observation, once.",
      "providerCapabilityPersistenceTransport and providerCapabilityPreparationTransport forward only the literal name their operation() call site passes, once.",
      "providerCapabilityPreparationPersistence and providerCapabilityRuntimePersistence call() receive only literal names from their exported wrappers.",
      "providerDispatchPreflight PREFLIGHT_RPC is the module constant api_authorize_provider_worker_dispatch.",
      "Staged only callers (stagedSource) resolve in no prechange catalog; the named staged file creates them.",
    ],
    gatewayCalls,
    hostedOrUnscannedCallers: "unverified",
  },
  catalog,
};
function formatManifest(value, depth = 0) {
  const pad = "  ".repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const formattedEntries = value.map((entry) => `${pad}  ${JSON.stringify(entry)}`);
    return `[\n${formattedEntries.join(",\n")}\n${pad}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    const formattedEntries = entries.map(([key, entry]) =>
      `${pad}  ${JSON.stringify(key)}: ${formatManifest(entry, depth + 1)}`);
    return `{\n${formattedEntries.join(",\n")}\n${pad}}`;
  }
  return JSON.stringify(value);
}
writeFileSync(outputPath, `${formatManifest(manifest)}\n`);
console.log(JSON.stringify({ output: outputPath, sha256: sha(readFileSync(outputPath)),
  functions: catalog.functions.length, literalCallers: literalCallers.length,
  dynamicSites: dynamic.length, gatewayCalls: gatewayCalls.length }));
