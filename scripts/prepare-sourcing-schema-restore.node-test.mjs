import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { prepareSourcingSchemaRestore } from "./prepare-sourcing-schema-restore.mjs";

const definition = `CREATE OR REPLACE FUNCTION graphql_public.graphql("operationName" text DEFAULT NULL::text, query text DEFAULT NULL::text, variables jsonb DEFAULT NULL::jsonb, extensions jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE sql
AS $function$
  select graphql.resolve(query := query);
$function$`;
const expectedHash = createHash("sha256").update(definition).digest("hex");
const grant = "GRANT ALL ON FUNCTION graphql_public.graphql(text,text,jsonb,jsonb) TO postgres;";
const dump = `CREATE EXTENSION IF NOT EXISTS pg_graphql WITH SCHEMA graphql;\n${grant}\n${grant}\n${grant}\n${grant}\nCREATE EVENT TRIGGER issue_pg_graphql_access ON ddl_command_end EXECUTE FUNCTION extensions.grant_pg_graphql_access();`;

test("terminates and attaches the wrapper before retaining every original grant", () => {
  const prepared = prepareSourcingSchemaRestore(dump, definition, expectedHash);
  assert.match(prepared, /\$function\$;\nALTER EXTENSION pg_graphql ADD FUNCTION graphql_public\.graphql\(text,text,jsonb,jsonb\);/);
  assert.equal((prepared.match(/GRANT ALL ON FUNCTION graphql_public\.graphql\(/g) ?? []).length, 4);
  assert.match(prepared, /GRANT USAGE ON SCHEMA graphql, graphql_public TO postgres WITH GRANT OPTION;/);
  assert.match(prepared, /GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA graphql TO postgres, anon, authenticated, service_role;/);
  assert.match(prepared, /GRANT ALL ON ALL SEQUENCES IN SCHEMA graphql TO postgres, anon, authenticated, service_role;/);
  assert.equal(prepared.slice(prepared.indexOf(grant)), dump.slice(dump.indexOf(grant)));
});

test("rejects drift in the wrapper and dump anchor", () => {
  assert.throws(() => prepareSourcingSchemaRestore(dump, definition + " ", expectedHash), /source_changed/);
  assert.throws(() => prepareSourcingSchemaRestore(dump.replace(grant, ""), definition, expectedHash), /acl_anchor_changed/);
});
