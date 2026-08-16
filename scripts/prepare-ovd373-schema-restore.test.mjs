import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.resolve(process.cwd(), "scripts/prepare-ovd373-schema-restore.mjs");

describe("OVD-373 schema restore preparation", () => {
  it("returns to the restore administrator before the managed default privileges", () => {
    const input = [
      "CREATE SCHEMA auth;",
      "CREATE SCHEMA public;",
      "CREATE FUNCTION public.example() RETURNS void LANGUAGE sql AS 'select';",
      "ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON FUNCTIONS TO postgres;",
      "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;",
      "\\unrestrict token",
      "",
    ].join("\n");

    const output = execFileSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      input,
    });

    const withPublicBaseline = input.replace(
      "CREATE SCHEMA public;",
      "CREATE SCHEMA public;\n\nALTER SCHEMA public OWNER TO pg_database_owner;\nGRANT USAGE ON SCHEMA public TO PUBLIC;",
    );
    expect(output).toBe(
      withPublicBaseline.replace(
        "ALTER DEFAULT PRIVILEGES",
        "RESET ROLE;\n\nALTER DEFAULT PRIVILEGES",
      ),
    );
    expect(output.match(/RESET ROLE;/g)).toHaveLength(1);
    expect(output.match(/GRANT USAGE ON SCHEMA public TO PUBLIC;/g)).toHaveLength(1);
  });

  it("fails closed when the expected default-privilege section is absent", () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      input: "CREATE SCHEMA public;\n",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("did not contain the expected default-privilege section");
  });

  it("fails closed when the public schema creation is absent", () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      input:
        "CREATE SCHEMA auth;\nALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;\n",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("did not contain the expected public-schema creation");
  });
});
