/**
 * Bind the OVD-510 pre-change compatibility matrix to one retained disposable
 * replay and to the current source's finite RPC call paths. This reads only
 * local synthetic fixture files and source; it never connects to a database.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixturePath = process.argv[2] && resolve(process.argv[2]);
const outputPath = process.argv[3] && resolve(process.argv[3]);
if (!fixturePath || !outputPath || !fixturePath.startsWith(`${join(root, "output")}/`)) {
  throw new Error("usage: node scripts/ovd510-build-compatibility-manifest.mjs <repo-output-fixture> <output-json>");
}
const read = (name) => JSON.parse(readFileSync(join(fixturePath, name), "utf8"));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const result = read("result.json");
const fixture = read("manifest.json");
const catalog = read("catalog.json");
const expectedCleanup = ["authSource", "container", "network", "storageSource"];
if (result.status !== "passed" || result.fixtureId !== fixture.fixtureId
    || result.sourceRevision !== fixture.sourceRevision
    || result.catalogSha256 !== sha(JSON.stringify(catalog))
    || !result.cleanup
    || Object.keys(result.cleanup).sort().join(",") !== expectedCleanup.sort().join(",")
    || expectedCleanup.some((key) => result.cleanup[key] !== "removed_owned")) {
  throw new Error("fixture_result_or_cleanup_mismatch");
}
const currentMigrations = readdirSync(join(root, "supabase", "migrations"))
  .filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
const replayedMigrations = fixture.manifest.map((entry) => entry.name).sort();
if (currentMigrations.join("|") !== replayedMigrations.join("|")) {
  throw new Error("migration_filename_set_drift");
}
for (const entry of fixture.manifest) {
  const current = sha(readFileSync(join(root, "supabase", "migrations", entry.name)));
  if (current !== entry.sha256) throw new Error(`migration_drift:${entry.name}`);
}
if (fixture.manifest.length !== 117 || catalog.functions.length !== 352
    || catalog.schemas.length !== 10 || catalog.policies.length !== 132
    || catalog.relations.length !== 135 || !Array.isArray(catalog.sequences)
    || result.sequenceCount !== catalog.sequences.length
    || catalog.functions.some((f) => !Array.isArray(f.explicit_grants)
      || (f.acl === null && f.explicit_grants.length !== 0))) {
  throw new Error("catalog_shape_mismatch");
}
const ownerSet = new Set(catalog.functions
  .filter((f) => ["public", "engineering_private", "storage"].includes(f.schema_name) && !f.extension_owned)
  .map((f) => f.owner));
if ([...ownerSet].sort().join(",") !== "postgres,supabase_storage_admin") {
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
  "supabase/functions/engineering-worker/index.ts:name",
  "supabase/functions/engineering-worker/index.ts:call.name",
];
if (dynamic.map((d) => `${d.file}:${d.expression}`).sort().join("|")
    !== expectedDynamic.sort().join("|")) {
  throw new Error(`unresolved_dynamic_rpc_site:${JSON.stringify(dynamic)}`);
}
const byName = new Map();
for (const f of catalog.functions) {
  const found = byName.get(f.function_name) ?? [];
  found.push(f);
  byName.set(f.function_name, found);
}
const literalCallers = refs.map((ref) => {
  const matches = byName.get(ref.name) ?? [];
  if (matches.length !== 1 || matches[0].schema_name !== "public") {
    throw new Error(`ambiguous_or_missing_rpc:${ref.file}:${ref.line}:${ref.name}`);
  }
  const f = matches[0];
  return { ...ref, exactIdentity: `public.${f.function_name}(${f.identity_arguments})`, definitionMd5: f.definition_md5 };
}).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
for (const name of ["api_consume_worker_pairing", "api_register_worker_boot", "api_worker_session_eligibility"]) {
  if (literalCallers.filter((r) => r.name === name).length !== 0) {
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
}).sort();
if (declaredGatewayNames.join(",") !== gatewayCalls.map((call) => call.name).sort().join(",")) {
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
if (returnedNames.sort().join(",") !== declaredGatewayNames.join(",")) {
  throw new Error("gateway_operation_dispatch_drift");
}
// Deliberate caller or dispatch changes require a reviewed new baseline. A
// regenerated catalog alone cannot approve a newly named application RPC.
const callerResolutionSha256 = sha(JSON.stringify({ literalCallers, dynamicSites: dynamic, gatewayCalls }));
if (callerResolutionSha256 !== "6c93ee9cb0afb7a58f571aade49b7a35ccbf41bd62290c073fabb58ced9ab6b7") {
  throw new Error("reviewed_rpc_caller_set_drift");
}
const dispatchSourceSha256 = {
  "src/features/quotes/api/shared/rpc.ts": "69570b9c2fc0a8b6604be3e1993441f0406f9b4664ede4f522b99ee301866ca0",
  "supabase/functions/engineering-worker/index.ts": "7fae7eba5e9d5c8f06ed1a7b6649e20c2759d5d4ae524e5863e8680fb47be2fb",
};
for (const [path, expected] of Object.entries(dispatchSourceSha256)) {
  if (sha(readFileSync(join(root, path))) !== expected) throw new Error(`reviewed_dispatch_source_drift:${path}`);
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
    ],
    gatewayCalls,
    hostedOrUnscannedCallers: "unverified",
  },
  catalog,
};
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ output: outputPath, sha256: sha(readFileSync(outputPath)),
  functions: catalog.functions.length, literalCallers: literalCallers.length,
  dynamicSites: dynamic.length, gatewayCalls: gatewayCalls.length }));
