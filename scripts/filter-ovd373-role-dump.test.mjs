import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const filterPath = path.resolve(process.cwd(), "scripts/filter-ovd373-role-dump.sh");

function filterRoleDump(input) {
  return execFileSync("bash", [filterPath], { encoding: "utf8", input });
}

describe("OVD-373 role-dump filter", () => {
  it("removes reserved-role creation, attributes, and membership grants", async () => {
    const output = filterRoleDump(`
CREATE ROLE "postgres";
ALTER ROLE "postgres" WITH SUPERUSER LOGIN;
GRANT "custom_reader" TO "postgres";
CREATE ROLE "custom_reader";
ALTER ROLE "custom_reader" WITH NOSUPERUSER NOREPLICATION LOGIN;
`);

    expect(output).not.toContain('CREATE ROLE "postgres"');
    expect(output).not.toContain('ALTER ROLE "postgres" WITH');
    expect(output).not.toContain('GRANT "custom_reader" TO "postgres"');
    expect(output).toContain('CREATE ROLE "custom_reader";');
    expect(output).toContain('ALTER ROLE "custom_reader" WITH LOGIN;');
    expect(output).toMatch(/RESET ALL;\s*$/);
  });

  it("preserves only allowlisted settings for reserved roles", async () => {
    const output = filterRoleDump(`
ALTER ROLE "postgres" SET "statement_timeout" TO '2min';
ALTER ROLE "postgres" SET "search_path" TO 'public';
ALTER ROLE "authenticator" SET "pgrst.db_schemas" TO 'public';
ALTER ROLE "service_role" SET "track_io_timing" TO 'on';
`);

    expect(output).toContain('ALTER ROLE "postgres" SET "statement_timeout" TO \'2min\';');
    expect(output).toContain('ALTER ROLE "authenticator" SET "pgrst.db_schemas" TO \'public\';');
    expect(output).toContain('ALTER ROLE "service_role" SET "track_io_timing" TO \'on\';');
    expect(output).not.toContain('"search_path"');
  });

  it("drops dump restrict meta commands and duplicate records", async () => {
    const output = filterRoleDump(`
\\restrict abc123
CREATE ROLE "custom_reader";
CREATE ROLE "custom_reader";
\\unrestrict abc123
`);

    expect(output).not.toContain('restrict');
    expect(output.match(/CREATE ROLE "custom_reader";/g)).toHaveLength(1);
  });

  it("matches the pinned CLI role filter for wildcard roles and every safe setting", () => {
    const input = [
      "\\restrict abc123",
      'CREATE ROLE "cli_login_postgres";',
      'ALTER ROLE "cli_login_postgres" WITH SUPERUSER LOGIN;',
      'CREATE ROLE "supabase_admin";',
      'ALTER ROLE "supabase_admin" WITH SUPERUSER LOGIN;',
      'ALTER ROLE "supabase_admin" SET "pgaudit.log" TO \'all\';',
      'ALTER ROLE "supabase_admin" SET "session_replication_role" TO \'replica\';',
      'ALTER ROLE "authenticator" SET "pgrst.db_schemas" TO \'public\';',
      'ALTER ROLE "postgres" SET "statement_timeout" TO \'2min\';',
      'ALTER ROLE "service_role" SET "track_io_timing" TO \'on\';',
      'ALTER ROLE "supabase_admin" SET "search_path" TO \'public\';',
      'GRANT "custom_reader" TO "cli_login_postgres";',
      'GRANT "custom_reader" TO "supabase_admin";',
      'CREATE ROLE "custom_reader";',
      'ALTER ROLE "custom_reader" WITH NOSUPERUSER NOREPLICATION LOGIN;',
      "\\unrestrict abc123",
      "",
    ].join("\n");

    expect(filterRoleDump(input)).toBe(
      [
        'ALTER ROLE "supabase_admin" SET "pgaudit.log" TO \'all\';',
        'ALTER ROLE "supabase_admin" SET "session_replication_role" TO \'replica\';',
        'ALTER ROLE "authenticator" SET "pgrst.db_schemas" TO \'public\';',
        'ALTER ROLE "postgres" SET "statement_timeout" TO \'2min\';',
        'ALTER ROLE "service_role" SET "track_io_timing" TO \'on\';',
        'CREATE ROLE "custom_reader";',
        'ALTER ROLE "custom_reader" WITH LOGIN;',
        "RESET ALL;",
        "",
      ].join("\n"),
    );
  });
});
