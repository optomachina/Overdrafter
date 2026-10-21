/** Generate reviewable, inert OVD-558 SQL from the pinned OVD-557 manifest. */
import { isEntryPoint } from "./lib/entry-point.mjs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allowedVerifierSignatures, buildAuthorityProofSql } from "./ovd510-build-authority-proof.mjs";
import { catalogSql } from "./ovd510-catalog-sql.mjs";
import { planExactGrants } from "./ovd510-plan-exact-grants.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestPath = resolve(root, "docs/release/ovd-510-prechange-compatibility-manifest.json");
const forwardPath = resolve(root, "docs/release/ovd-558-verifier-authority-forward.sql");
const reversePath = resolve(root, "docs/release/ovd-558-verifier-authority-reverse.sql");
const digestPath = resolve(root, "docs/release/window-2/ovd558-catalog-digest.sql");
const manifestBytes = readFileSync(manifestPath);
const manifestSha = createHash("sha256").update(manifestBytes).digest("hex");
const manifest = JSON.parse(manifestBytes);
const plan = planExactGrants(manifest, manifestSha);
// The catalog digest is taken with search_path = pg_catalog, so expressions and
// function definitions render fully qualified and the digest does not depend on
// the runner's role or its role level search_path (OVD-743). Measured as
// postgres on the 148 migration baseline.
const baselineCanonicalSha = "e1947671b453122789c6ba947bac2a279973a8a429815a8a18f16f8c941e9d0b";
const catalogSelect = catalogSql.replace(/^begin read only;\n/, "").replace(/\ncommit;$/, "");
if (!catalogSelect.startsWith("with selected_roles(role_name) as (")
    || !catalogSelect.endsWith(")::text;")) throw new Error("catalog_select_shape_drift");
const digestQuery = (select) => {
  const source = `(${select.slice(0, -1)}) snapshot(catalog_value)`;
  return `select encode(sha256(convert_to(catalog_value, 'UTF8')), 'hex') from ${source}`;
};
// Inside a DO block that declares saved_search_path; the session path is restored.
const pinnedDigestInto = (target) => `perform set_config('search_path', 'pg_catalog', true);
  select digest_value into ${target} from (${digestQuery(catalogSelect)}) as digest(digest_value);
  perform set_config('search_path', saved_search_path, true);`;
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const signature = (fn) => `${fn.schema_name}.${fn.function_name}(${fn.identity_arguments
  ? fn.identity_arguments.split(",").map((arg) => arg.trim().split(/\s+/).at(-1)).join(",") : ""})`;
// OVD-743 option A: the verifier may call exactly the 7 application functions,
// plus exactly the storage functions anon can call (nothing anon cannot).
export const verifierAppFunctions = [...allowedVerifierSignatures].sort(byCodeUnit);
export const anonStorageFunctions = manifest.catalog.functions
  .filter((fn) => fn.schema_name === "storage" && !fn.extension_owned
    && fn.callers.anon?.schemaUsage && fn.callers.anon?.functionExecute)
  .map(signature).sort(byCodeUnit);
if (verifierAppFunctions.length !== 7 || anonStorageFunctions.length !== 20) {
  throw new Error("reviewed_verifier_function_set_drift");
}
const sqlArray = (list) => `array[${list.map((name) => `'${name}'`).join(",\n    ")}]::text[]`;
const callable = (role, schemaFilter) => `(select coalesce(array_agg(p.oid::regprocedure::text
      order by p.oid::regprocedure::text collate "C"), '{}')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where ${schemaFilter} and has_schema_privilege('${role}', n.oid, 'USAGE')
      and has_function_privilege('${role}', p.oid, 'EXECUTE'))`;
const verifierAuthorityChecks = `select ${callable("engineering_native_verifier", "n.nspname in ('public','engineering_private')")} into found;
  if found is distinct from ${sqlArray(verifierAppFunctions)} then
    raise exception 'ovd558_verifier_app_allowlist_mismatch:%', found;
  end if;
  select ${callable("engineering_native_verifier", "n.nspname = 'storage'")} into found;
  select ${callable("anon", "n.nspname = 'storage'")} into anon_found;
  if found is distinct from anon_found then
    raise exception 'ovd558_verifier_storage_functions_exceed_anon:%', found;
  end if;
  -- Fails closed when a Supabase Storage upgrade adds or changes a function.
  if anon_found is distinct from ${sqlArray(anonStorageFunctions)} then
    raise exception 'ovd558_storage_anon_functions_changed:%', anon_found;
  end if;
  if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as priv(name)
      where n.nspname = 'storage' and c.relkind in ('r','p','v','m','f')
        and has_table_privilege('engineering_native_verifier', c.oid, priv.name)
        and not has_table_privilege('anon', c.oid, priv.name)) then
    raise exception 'ovd558_verifier_storage_table_exceeds_anon';
  end if;
  if exists (select 1 from pg_namespace n where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
      and (has_schema_privilege('engineering_native_verifier', n.oid, 'CREATE')
        or has_schema_privilege('engineering_native_verifier', n.oid, 'USAGE')
          <> (n.nspname in ('public','engineering_private','storage')))) then
    raise exception 'ovd558_verifier_schema_authority_mismatch';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','engineering_private')
      and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) a
        where a.grantee = 0 and a.privilege_type = 'EXECUTE')) then
    raise exception 'ovd558_public_execute_leak';
  end if;`;
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const identity = (fn) => `${quote(fn.schema_name)}.${quote(fn.function_name)}(${fn.identity_arguments})`;
const sqlSha = (value) => createHash("sha256").update(value).digest("hex");

function forwardSql(postCanonicalSha) {
  const proof = buildAuthorityProofSql(plan.sql, catalogSelect);
  const start = proof.indexOf("create role engineering_native_verifier\n");
  const end = proof.indexOf("set role postgres;\ncreate function public.ovd510_future_public()", start);
  if (start < 0 || end < start) throw new Error("proof_mutation_boundary_drift");
  let mutation = proof.slice(start, end);
  mutation = mutation.replace("insert into engineering_private.ovd510_proof_registry values\n  ('ovd510-proof', 'registered-result');\n", "");
  mutation = mutation.replaceAll("ovd510_proof_registry", "native_verifier_registered_objects");
  mutation = mutation.replace(/create function public\.ovd510_unlisted_plain\(\)[\s\S]*?(?=revoke execute on function public\.api_load_native_verification)/, "");
  if (mutation.includes("ovd510_unlisted_") || mutation.includes("registered-result")
      || /set role "?supabase_storage_admin|for role supabase_storage_admin/i.test(mutation)
      || !mutation.includes(plan.sql)) {
    throw new Error("proof_mutation_extraction_failed");
  }
  const postCheck = postCanonicalSha
    ? `${pinnedDigestInto("actual")}
  if actual is distinct from '${postCanonicalSha}' then
    raise exception 'ovd558_postchange_catalog_mismatch:%', actual;
  end if;`
    : "";
  return `-- OVD-558 staged source migration. Do not add this file to the active migration tree.
-- Pinned prechange manifest SHA-256: ${manifestSha}
-- Pinned PostgreSQL jsonb catalog SHA-256 (search_path pg_catalog): ${baselineCanonicalSha}
-- Runs as postgres, the hosted Supabase owner role; no superuser is needed.
-- Storage functions are owned by supabase_storage_admin and keep their shipped
-- ACLs: the verifier may call exactly the storage functions anon can call.
-- READ COMMITTED and the shared window 2 lock come first, as in every staged
-- forward and reverse, so no two window 2 scripts interleave.
begin;
set local statement_timeout = '180s';
set local lock_timeout = '10s';
do $ovd558_forward_isolation$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'ovd558_forward_read_committed_required' using errcode = '0A000';
  end if;
end $ovd558_forward_isolation$;
select pg_advisory_xact_lock(510, 2);
do $ovd558_preflight$ declare actual text; saved_search_path text := current_setting('search_path');
begin
  if current_user <> 'postgres'
     or to_regrole('engineering_native_verifier') is not null
     or to_regclass('engineering_private.native_verifier_registered_objects') is not null
     or to_regprocedure('public.api_load_native_verification(uuid,uuid)') is not null then
    raise exception 'ovd558_runner_or_object_preflight_mismatch';
  end if;
  ${pinnedDigestInto("actual")}
  if actual is distinct from '${baselineCanonicalSha}' then
    raise exception 'ovd558_prechange_catalog_mismatch:%', actual;
  end if;
end $ovd558_preflight$;
${mutation}
do $ovd558_postflight$ declare actual text; found text[]; anon_found text[];
  saved_search_path text := current_setting('search_path');
begin
  perform set_config('search_path', 'pg_catalog', true);
  ${verifierAuthorityChecks}
  perform set_config('search_path', saved_search_path, true);
  ${postCheck}
end $ovd558_postflight$;
commit;
`;
}

function reverseSql(postCanonicalSha, forwardSha) {
  const reverseGrants = plan.grants.map((grant) => grant.statement
    .replace(/^GRANT EXECUTE/, "REVOKE EXECUTE").replace(/ TO ("[^"]+");$/, " FROM $1;"));
  const originalPublicAcl = "{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}";
  const publicRestores = manifest.catalog.functions.filter((fn) =>
    fn.schema_name === "public" && fn.public_execute && !fn.extension_owned)
    .map((fn) => {
      if (fn.acl !== originalPublicAcl) throw new Error("unreviewed_public_acl_shape");
      const target = identity(fn);
      return { owner: fn.owner, statement: [
        `revoke execute on function ${target} from public, postgres, anon, authenticated, service_role;`,
        ...["public", "postgres", "anon", "authenticated", "service_role"].map((grantee) =>
          `grant execute on function ${target} to ${grantee};`),
      ].join("\n") };
    });
  const grouped = (entries) => {
    const owners = new Map();
    for (const entry of entries) {
      const list = owners.get(entry.owner) ?? [];
      list.push(entry.statement);
      owners.set(entry.owner, list);
    }
    return [...owners].map(([owner, statements]) =>
      `set role ${quote(owner)};\n${statements.join("\n")}\nreset role;`).join("\n");
  };
  return `-- OVD-558 separate source-only reverse migration.
-- Exact forward SQL SHA-256: ${forwardSha}
-- Pinned prechange manifest SHA-256: ${manifestSha}
-- Runs as postgres. Restores the exact prechange catalog (storage untouched).
-- READ COMMITTED and the registry lock come first so the emptiness check reads
-- a snapshot taken after every concurrent registry writer has finished.
-- storage.objects is locked before the registry, the order a verifier read
-- takes them through its policy, so a concurrent read cannot deadlock.
begin;
set local statement_timeout = '180s';
set local lock_timeout = '10s';
do $ovd558_reverse_isolation$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'ovd558_reverse_read_committed_required' using errcode = '0A000';
  end if;
end $ovd558_reverse_isolation$;
select pg_advisory_xact_lock(510, 2);
do $ovd558_reverse_lock$
begin
  if current_user <> 'postgres'
     or to_regclass('engineering_private.native_verifier_registered_objects') is null then
    raise exception 'ovd558_reverse_runner_or_registry_mismatch';
  end if;
  lock table storage.objects, engineering_private.native_verifier_registered_objects
    in access exclusive mode;
end $ovd558_reverse_lock$;
do $ovd558_reverse_preflight$ declare actual text; saved_search_path text := current_setting('search_path');
begin
  if current_user <> 'postgres'
     or to_regrole('engineering_native_verifier') is null
     or (select count(*) from engineering_private.native_verifier_registered_objects) <> 0 then
    raise exception 'ovd558_reverse_runner_or_registry_mismatch';
  end if;
  ${pinnedDigestInto("actual")}
  if actual is distinct from '${postCanonicalSha}' then
    raise exception 'ovd558_unknown_postchange_catalog:%', actual;
  end if;
end $ovd558_reverse_preflight$;
drop policy ovd510_verifier_registered_permissive on storage.objects;
drop policy ovd510_verifier_registered_restrictive on storage.objects;
revoke engineering_native_verifier from authenticator;
revoke execute on function public.api_load_native_verification(uuid,uuid),
  public.api_complete_native_verification(uuid,text),
  public.api_reject_native_verification(uuid,jsonb),
  engineering_private.load_native_verification(uuid,uuid),
  engineering_private.complete_native_verification(uuid,text),
  engineering_private.reject_native_verification(uuid,jsonb),
  engineering_private.native_verifier_can_read_object(text,text)
  from engineering_native_verifier;
revoke select on storage.objects from engineering_native_verifier;
revoke usage on schema public, engineering_private, storage from engineering_native_verifier;
set role postgres;
drop function public.api_load_native_verification(uuid,uuid),
  public.api_complete_native_verification(uuid,text),
  public.api_reject_native_verification(uuid,jsonb),
  engineering_private.load_native_verification(uuid,uuid),
  engineering_private.complete_native_verification(uuid,text),
  engineering_private.reject_native_verification(uuid,jsonb),
  engineering_private.native_verifier_can_read_object(text,text) restrict;
drop table engineering_private.native_verifier_registered_objects restrict;
reset role;
drop role engineering_native_verifier;
${grouped(plan.grants.map((grant, index) => ({ owner: grant.owner, statement: reverseGrants[index] })))}
${grouped(publicRestores)}
alter default privileges for role postgres in schema private, extensions revoke execute on functions from public;
alter default privileges for role postgres grant execute on functions to public;
do $ovd558_reverse_postflight$ declare actual text; saved_search_path text := current_setting('search_path');
begin
  ${pinnedDigestInto("actual")}
  if actual is distinct from '${baselineCanonicalSha}' then
    raise exception 'ovd558_reverse_catalog_mismatch:%', actual;
  end if;
end $ovd558_reverse_postflight$;
commit;
`;
}

/** The lead's read only go or no go query: the forward preflight digest, verbatim. */
export function digestSql() {
  return `-- OVD-743 window 2 go or no go: READ ONLY. Prints the catalog digest that the
-- OVD-558 forward preflight computes, generated with it by
-- scripts/ovd510-generate-migration-sql.mjs (do not edit). The digest is taken
-- with search_path = pg_catalog, so it is the same for any role; run it as
-- postgres. It writes nothing and holds no lock beyond a read only snapshot.
-- Usage (lead only, never an agent): psql "$DB_URL" -X -At -f docs/release/window-2/ovd558-catalog-digest.sql
begin read only;
set local search_path = pg_catalog;
${digestQuery(catalogSelect)};
rollback;
`;
}

if (isEntryPoint(import.meta.url)) {
  const postSha = process.argv[2];
  const checkOnly = process.argv.includes("--check");
  if (postSha && !/^[0-9a-f]{64}$/.test(postSha)) throw new Error("post_catalog_sha_required");
  if (checkOnly && !postSha) throw new Error("check_requires_post_catalog_sha");
  const forward = forwardSql(postSha);
  const reverse = postSha ? reverseSql(postSha, sqlSha(forward)) : null;
  const digest = digestSql();
  if (checkOnly) {
    if (readFileSync(forwardPath, "utf8") !== forward
        || readFileSync(reversePath, "utf8") !== reverse
        || readFileSync(digestPath, "utf8") !== digest) {
      throw new Error("staged_migration_source_drift");
    }
  } else {
    writeFileSync(forwardPath, forward);
    if (reverse) writeFileSync(reversePath, reverse);
    writeFileSync(digestPath, digest);
  }
  process.stdout.write(JSON.stringify({ forwardSha256: sqlSha(forward),
    reverseSha256: reverse ? sqlSha(reverse) : null, digestSha256: sqlSha(digest),
    postCatalogSha256: postSha ?? null }) + "\n");
}
