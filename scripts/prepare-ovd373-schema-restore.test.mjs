import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = path.resolve(process.cwd(), "scripts/prepare-ovd373-schema-restore.mjs");

describe("OVD-373 schema restore preparation", () => {
  it("returns to the restore administrator before the managed default privileges", () => {
    const input = [
      "CREATE SCHEMA auth;",
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

    expect(output).toBe(input.replace("ALTER DEFAULT PRIVILEGES", "RESET ROLE;\n\nALTER DEFAULT PRIVILEGES"));
    expect(output.match(/RESET ROLE;/g)).toHaveLength(1);
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
});
