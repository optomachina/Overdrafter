import process from "node:process";

const DEFAULT_PRIVILEGE_STATEMENT = /^ALTER DEFAULT PRIVILEGES /m;

/**
 * Reads a plain-text `pg_dump --schema-only` stream from stdin and writes the
 * same stream to stdout with one `RESET ROLE` before its first managed
 * `ALTER DEFAULT PRIVILEGES` statement. The restore starts schema creation as
 * `postgres`, then must return to its `supabase_admin` session before changing
 * defaults owned by Supabase-managed roles. A dump without that section is
 * rejected instead of producing an artifact with ambiguous restore semantics.
 */
async function main() {
  process.stdin.setEncoding("utf8");

  let schemaDump = "";
  for await (const chunk of process.stdin) {
    schemaDump += chunk;
  }

  const firstDefaultPrivilege = schemaDump.search(DEFAULT_PRIVILEGE_STATEMENT);
  if (firstDefaultPrivilege < 0) {
    throw new Error("Schema dump did not contain the expected default-privilege section.");
  }

  process.stdout.write(
    `${schemaDump.slice(0, firstDefaultPrivilege)}RESET ROLE;\n\n${schemaDump.slice(firstDefaultPrivilege)}`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown schema preparation error.";
  process.stderr.write(`OVD-373 schema preparation failed: ${message}\n`);
  process.exitCode = 1;
});
