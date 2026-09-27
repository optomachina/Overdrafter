/** Generate reviewable, inert OVD-558 SQL from the pinned OVD-557 manifest. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildAuthorityProofSql } from "./ovd510-build-authority-proof.mjs";
import { catalogSql } from "./ovd510-catalog-sql.mjs";
import { planExactGrants } from "./ovd510-plan-exact-grants.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifestPath = resolve(root, "docs/release/ovd-510-prechange-compatibility-manifest.json");
const forwardPath = resolve(root, "docs/release/ovd-558-verifier-authority-forward.sql");
const reversePath = resolve(root, "docs/release/ovd-558-verifier-authority-reverse.sql");
const manifestBytes = readFileSync(manifestPath);
const manifestSha = createHash("sha256").update(manifestBytes).digest("hex");
const manifest = JSON.parse(manifestBytes);
const plan = planExactGrants(manifest, manifestSha);
// pg_get_functiondef/pg_get_expr render under the runner role, so this is the
// supabase_admin view of the same reviewed catalog, not the postgres JSON hash.
const baselineCanonicalSha = "ee81feb70d8a72cb1baa3c73109c311504b9079603b51954a3f6d50a8a763dc1";
const catalogSelect = catalogSql.replace(/^begin read only;\n/, "").replace(/\ncommit;$/, "");
if (!catalogSelect.startsWith("with selected_roles(role_name) as (")
    || !catalogSelect.endsWith(")::text;")) throw new Error("catalog_select_shape_drift");
const catalogJsonbSelect = catalogSelect.replace(/\)::text;$/, ");");
const digestQuery = (select, normalized = false) => {
  const source = `(${select.slice(0, -1)}) snapshot(catalog_value)`;
  if (!normalized) {
    return `select encode(sha256(convert_to(catalog_value, 'UTF8')), 'hex') from ${source}`;
  }
  return `select encode(sha256(convert_to(
    jsonb_set(catalog_value, '{functions}',
      (select jsonb_agg(case when item->>'schema_name' = 'storage'
        then jsonb_set(jsonb_set(item, '{acl}', 'null'::jsonb),
          '{explicit_grants}', '[]'::jsonb) else item end order by ordinal)
       from jsonb_array_elements(catalog_value->'functions') with ordinality as f(item, ordinal)))::text,
    'UTF8')), 'hex') from ${source}`;
};
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
      || !mutation.includes(plan.sql)) throw new Error("proof_mutation_extraction_failed");
  const postCheck = postCanonicalSha
    ? `select digest_value into actual from (${digestQuery(catalogSelect)}) as digest(digest_value);
  if actual is distinct from '${postCanonicalSha}' then
    raise exception 'ovd558_postchange_catalog_mismatch:%', actual;
  end if;`
    : `if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','engineering_private','storage')
        and has_schema_privilege('engineering_native_verifier', n.oid, 'USAGE')
        and has_function_privilege('engineering_native_verifier', p.oid, 'EXECUTE')) <> 7 then
    raise exception 'ovd558_verifier_allowlist_count_mismatch';
  end if;`;
  return `-- OVD-558 staged source migration. Do not add this file to the active migration tree.
-- Pinned prechange manifest SHA-256: ${manifestSha}
-- Pinned PostgreSQL jsonb catalog SHA-256: ${baselineCanonicalSha}
-- Requires separately qualified source, fixture ownership, and runner identity.
begin;
set local statement_timeout = '180s';
set local lock_timeout = '10s';
select pg_advisory_xact_lock(510, 2);
do $ovd558_preflight$ declare actual text;
begin
  if current_user <> 'supabase_admin'
     or not (select rolsuper from pg_roles where rolname = current_user)
     or to_regrole('engineering_native_verifier') is not null
     or to_regclass('engineering_private.native_verifier_registered_objects') is not null
     or to_regprocedure('public.api_load_native_verification(uuid,uuid)') is not null then
    raise exception 'ovd558_runner_or_object_preflight_mismatch';
  end if;
  select digest_value into actual from (${digestQuery(catalogSelect)}) as digest(digest_value);
  if actual is distinct from '${baselineCanonicalSha}' then
    raise exception 'ovd558_prechange_catalog_mismatch:%', actual;
  end if;
end $ovd558_preflight$;
${mutation}
do $ovd558_postflight$ declare actual text; found text[];
begin
  select array_agg(n.nspname || '.' || p.proname || '(' ||
    pg_get_function_identity_arguments(p.oid) || ')' order by n.nspname, p.proname)
    into found from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','engineering_private','storage')
      and has_schema_privilege('engineering_native_verifier', n.oid, 'USAGE')
      and has_function_privilege('engineering_native_verifier', p.oid, 'EXECUTE');
  if coalesce(array_length(found, 1), 0) <> 7 then
    raise exception 'ovd558_verifier_allowlist_count_mismatch:%', found;
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public','engineering_private','storage')
      and exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) a
        where a.grantee = 0 and a.privilege_type = 'EXECUTE')) then
    raise exception 'ovd558_public_execute_leak';
  end if;
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
  const storagePublicGrants = manifest.catalog.functions.filter((fn) =>
    fn.schema_name === "storage" && !fn.extension_owned && fn.public_execute)
    .map((fn) => ({ owner: fn.owner,
      statement: `grant execute on function ${identity(fn)} to public;` }));
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
-- Only storage function raw proacl null-to-explicit normalization is permitted.
begin;
set local statement_timeout = '180s';
set local lock_timeout = '10s';
select pg_advisory_xact_lock(510, 2);
do $ovd558_reverse_preflight$ declare actual text;
begin
  if current_user <> 'supabase_admin'
     or not (select rolsuper from pg_roles where rolname = current_user)
     or to_regrole('engineering_native_verifier') is null
     or (select count(*) from engineering_private.native_verifier_registered_objects) <> 0 then
    raise exception 'ovd558_reverse_runner_or_registry_mismatch';
  end if;
  select digest_value into actual from (${digestQuery(catalogSelect)}) as digest(digest_value);
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
${grouped(storagePublicGrants)}
alter default privileges for role postgres in schema private, extensions revoke execute on functions from public;
alter default privileges for role postgres grant execute on functions to public;
alter default privileges for role supabase_storage_admin grant execute on functions to public;
do $ovd558_reverse_postflight$ declare actual text;
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'storage' and not exists (
      select 1 from aclexplode(p.proacl) a
      where a.grantee = 0 and a.grantor = p.proowner
        and a.privilege_type = 'EXECUTE' and not a.is_grantable))
     or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       cross join lateral aclexplode(p.proacl) a
       where n.nspname = 'storage' and
         (a.grantor <> p.proowner or a.privilege_type <> 'EXECUTE'
          or a.is_grantable or a.grantee not in (0, p.proowner))) then
    raise exception 'ovd558_storage_expanded_acl_mismatch';
  end if;
  select digest_value into actual from (${digestQuery(catalogJsonbSelect, true)}) as digest(digest_value);
  if actual is distinct from '${baselineCanonicalSha}' then
    raise exception 'ovd558_reverse_catalog_mismatch:%', actual;
  end if;
end $ovd558_reverse_postflight$;
commit;
`;
}

const postSha = process.argv[2];
const checkOnly = process.argv.includes("--check");
if (postSha && !/^[0-9a-f]{64}$/.test(postSha)) throw new Error("post_catalog_sha_required");
if (checkOnly && !postSha) throw new Error("check_requires_post_catalog_sha");
const forward = forwardSql(postSha);
const reverse = postSha ? reverseSql(postSha, sqlSha(forward)) : null;
if (checkOnly) {
  if (readFileSync(forwardPath, "utf8") !== forward
      || readFileSync(reversePath, "utf8") !== reverse) {
    throw new Error("staged_migration_source_drift");
  }
} else {
  writeFileSync(forwardPath, forward);
  if (reverse) writeFileSync(reversePath, reverse);
}
process.stdout.write(JSON.stringify({ forwardSha256: sqlSha(forward),
  reverseSha256: reverse ? sqlSha(reverse) : null,
  postCatalogSha256: postSha ?? null }) + "\n");
