import { createHash } from "node:crypto";

const signature = "graphql_public.graphql(text,text,jsonb,jsonb)";
const aclAnchor = "\nGRANT ALL ON FUNCTION graphql_public.graphql(";

/** Restore the one extension-owned GraphQL wrapper omitted by pg_dump. */
export function prepareSourcingSchemaRestore(dump, definition, expectedDefinitionSha256) {
  const definitionSha256 = createHash("sha256").update(definition).digest("hex");
  if (definitionSha256 !== expectedDefinitionSha256 || !definition.startsWith("CREATE OR REPLACE FUNCTION graphql_public.graphql(")) {
    throw new Error("graphql_wrapper_source_changed");
  }
  if (definition.endsWith(";") || !definition.endsWith("$function$")) {
    throw new Error("graphql_wrapper_terminator_changed");
  }
  const index = dump.indexOf(aclAnchor);
  if (index < 0 || (dump.match(/GRANT ALL ON FUNCTION graphql_public\.graphql\(/g) ?? []).length !== 4
    || dump.indexOf("CREATE EXTENSION IF NOT EXISTS pg_graphql") > index
    || dump.indexOf("CREATE EVENT TRIGGER issue_pg_graphql_access") < index) {
    throw new Error("graphql_wrapper_acl_anchor_changed");
  }
  // The platform event hook ran before pg_graphql installation in the source
  // database. pg_dump omits grants on its extension-owned schema, functions,
  // and sequence. Replay that exact hook result; the runner then compares
  // every schema/function/relation ACL to the source before any migration.
  const insertion = `\n${definition};
ALTER EXTENSION pg_graphql ADD FUNCTION ${signature};
GRANT USAGE ON SCHEMA graphql, graphql_public TO postgres WITH GRANT OPTION;
GRANT USAGE ON SCHEMA graphql, graphql_public TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA graphql TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA graphql TO postgres, anon, authenticated, service_role;
`;
  return dump.slice(0, index) + insertion + dump.slice(index);
}
