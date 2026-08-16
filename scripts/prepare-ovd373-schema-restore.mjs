import process from "node:process";

const DEFAULT_PRIVILEGE_STATEMENT = /^ALTER DEFAULT PRIVILEGES /m;
const PUBLIC_SCHEMA_STATEMENT = /^CREATE SCHEMA public;$/m;
const PUBLIC_SCHEMA_BASELINE = [
  "ALTER SCHEMA public OWNER TO pg_database_owner;",
  "GRANT USAGE ON SCHEMA public TO PUBLIC;",
].join("\n");

/**
 * Reads a plain-text `pg_dump --schema-only` stream from stdin and writes the
 * same stream to stdout with the managed `public`-schema baseline restored and
 * one `RESET ROLE` before its first managed `ALTER DEFAULT PRIVILEGES`
 * statement. Dropping the destination's pre-created `public` schema removes
 * the provider's owner and PUBLIC-usage defaults, which `pg_dump` omits as
 * baseline state. The restore starts schema creation as `postgres`, then must
 * return to its `supabase_admin` session before changing defaults owned by
 * Supabase-managed roles. A dump without either expected section is rejected.
 */
async function main() {
  process.stdin.setEncoding("utf8");

  let schemaDump = "";
  for await (const chunk of process.stdin) {
    schemaDump += chunk;
  }

  const publicSchema = PUBLIC_SCHEMA_STATEMENT.exec(schemaDump);
  if (publicSchema?.index === undefined) {
    throw new Error("Schema dump did not contain the expected public-schema creation.");
  }

  const publicSchemaEnd = publicSchema.index + publicSchema[0].length;
  const preparedSchemaDump = `${schemaDump.slice(0, publicSchemaEnd)}\n\n${PUBLIC_SCHEMA_BASELINE}${schemaDump.slice(publicSchemaEnd)}`;
  const firstDefaultPrivilege = preparedSchemaDump.search(DEFAULT_PRIVILEGE_STATEMENT);
  if (firstDefaultPrivilege < 0) {
    throw new Error("Schema dump did not contain the expected default-privilege section.");
  }

  process.stdout.write(
    `${preparedSchemaDump.slice(0, firstDefaultPrivilege)}RESET ROLE;\n\n${preparedSchemaDump.slice(firstDefaultPrivilege)}`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown schema preparation error.";
  process.stderr.write(`OVD-373 schema preparation failed: ${message}\n`);
  process.exitCode = 1;
});
