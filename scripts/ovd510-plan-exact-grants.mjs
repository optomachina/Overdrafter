/**
 * Derive the finite replacement EXECUTE grants for the OVD-510 disposable
 * authority proof. Input is the reviewed pre-change manifest, never a live or
 * post-change catalog. SQL is emitted only under output/ for a fresh fixture.
 */
const expectedManifestSha256 = "718d89bfa7ed8059cc1c5eb951e14466fac4fa71df8087723a7abe5697ce8bac";
const targetSchemas = new Set(["public", "engineering_private", "storage"]);
const allowedOwners = new Map([
  ["public", "postgres"],
  ["engineering_private", "postgres"],
  ["storage", "supabase_storage_admin"],
]);
const quote = (identifier) => `"${identifier.replaceAll('"', '""')}"`;

export function planExactGrants(manifest, manifestSha256) {
  if (manifestSha256 !== expectedManifestSha256 || manifest.version !== 1
      || manifest.scope !== "synthetic_disposable_source_only_prechange"
      || manifest.fixture?.migrationCount !== 117
      || manifest.catalog?.functions?.length !== 352
      || manifest.catalog?.roles?.length !== 13) {
    throw new Error("unreviewed_prechange_manifest");
  }
  const roles = new Map(manifest.catalog.roles.map((role) => [role.rolname, role]));
  if (roles.size !== 13 || [...roles.values()].some((role) => !role.rolname)) {
    throw new Error("role_catalog_mismatch");
  }
  const identities = new Set();
  const grants = [];
  for (const fn of manifest.catalog.functions) {
    const identity = `${fn.schema_name}.${fn.function_name}(${fn.identity_arguments})`;
    if (identities.has(identity)) throw new Error(`duplicate_function_identity:${identity}`);
    identities.add(identity);
    if (!targetSchemas.has(fn.schema_name) || fn.extension_owned) continue;
    if (fn.owner !== allowedOwners.get(fn.schema_name)
        || !fn.callers || typeof fn.public_execute !== "boolean"
        || !Array.isArray(fn.explicit_grants)) {
      throw new Error(`unreviewed_function_owner_or_shape:${identity}`);
    }
    for (const [name, role] of roles) {
      const access = fn.callers[name];
      if (!access || typeof access.schemaUsage !== "boolean"
          || typeof access.functionExecute !== "boolean") {
        throw new Error(`incomplete_caller_matrix:${identity}:${name}`);
      }
      if (!access.schemaUsage || !access.functionExecute || name === fn.owner || role.rolsuper) continue;
      const direct = fn.explicit_grants.some((grant) =>
        grant.grantee === name && grant.privilege === "EXECUTE");
      if (direct) continue;
      if (!fn.public_execute) {
        throw new Error(`unexplained_inherited_execute:${identity}:${name}`);
      }
      grants.push({ identity, schema: fn.schema_name, owner: fn.owner, role: name,
        statement: `GRANT EXECUTE ON FUNCTION ${quote(fn.schema_name)}.${quote(fn.function_name)}(${fn.identity_arguments}) TO ${quote(name)};` });
    }
  }
  grants.sort((a, b) => a.owner.localeCompare(b.owner)
    || a.identity.localeCompare(b.identity) || a.role.localeCompare(b.role));
  const byOwner = new Map();
  for (const grant of grants) {
    const statements = byOwner.get(grant.owner) ?? [];
    statements.push(grant.statement);
    byOwner.set(grant.owner, statements);
  }
  const sql = ["-- OVD-510 exact replacement grants from the pinned pre-change manifest.",
    "-- Requires an asserted, exclusively owned disposable replay and one outer transaction."];
  for (const [owner, statements] of byOwner) {
    sql.push(`SET ROLE ${quote(owner)};`, ...statements, "RESET ROLE;");
  }
  const counts = Object.fromEntries([...targetSchemas].map((schema) =>
    [schema, grants.filter((grant) => grant.schema === schema).length]));
  if (counts.public !== 616 || counts.engineering_private !== 0 || counts.storage !== 140) {
    throw new Error(`reviewed_grant_count_drift:${JSON.stringify(counts)}`);
  }
  return { grants, counts, sql: `${sql.join("\n")}\n` };
}
