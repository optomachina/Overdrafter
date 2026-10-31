import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aclStatements, assertProofDatabaseUrl, libpqHost, proofPsqlEnv } from "./ovd979-rollback.mjs";

const script = join(process.cwd(), "scripts", "ovd979-rollback.mjs");
const migration = "20261031034700_ovd979u2_canonical_requirement_lock_order.sql";

describe("ovd979-rollback --prove database URL guard", () => {
  it.each([
    "postgresql://postgres:postgres@localhost:54322/postgres",
    "postgres://postgres@127.0.0.1:56322/postgres?sslmode=disable",
    "postgresql://postgres@[::1]:5432/postgres",
    "postgresql://LOCALHOST/postgres",
    "postgresql://postgres@%2Ftmp:5432/postgres",
    "postgresql://%2Fvar%2Frun%2Fpostgresql/postgres",
  ])("accepts the local URL %s", (url) => {
    expect(() => assertProofDatabaseUrl(url)).not.toThrow();
  });

  it.each([
    ["hostaddr override", "postgresql://localhost/postgres?hostaddr=192.0.2.1"],
    ["host override", "postgresql://localhost/postgres?host=db.example.com"],
    ["service override", "postgresql://localhost/postgres?service=prod"],
    ["servicefile override", "postgresql://localhost/postgres?sslmode=disable&servicefile=/tmp/x"],
    ["upper-case HOSTADDR", "postgresql://localhost/postgres?HOSTADDR=192.0.2.1"],
    ["mixed-case Host", "postgresql://localhost/postgres?Host=db.example.com"],
    ["percent-encoded key", "postgresql://localhost/postgres?%68ostaddr=192.0.2.1"],
    ["remote host", "postgresql://postgres@db.example.com:5432/postgres"],
    ["remote IPv4", "postgresql://192.0.2.1/postgres"],
    ["remote IPv6", "postgresql://[2001:db8::1]:5432/postgres"],
    ["IPv6 other than ::1", "postgresql://[::2]/postgres"],
    ["user@remote", "postgresql://localhost@db.example.com/postgres"],
    ["user:password@remote", "postgresql://postgres:localhost@db.example.com/postgres"],
    ["two '@' in authority", "postgresql://a@db.example.com@localhost/postgres"],
    ["multi-host list", "postgresql://localhost,db.example.com/postgres"],
    ["multi-host with ports", "postgresql://localhost:5432,db.example.com:5432/postgres"],
    ["encoded comma", "postgresql://localhost%2Cdb.example.com/postgres"],
    ["fragment hiding a query", "postgresql://localhost#?hostaddr=192.0.2.1"],
    ["'@' after '?' (libpq reads user info past the query)", "postgresql://localhost?x@db.example.com/postgres"],
    ["'@' after '?' with no path", "postgresql://localhost?sslmode=disable@192.0.2.1"],
    ["dbname as a second connection string", "postgresql://localhost/postgres?dbname=host%3Ddb.example.com"],
    ["empty host", "postgresql:///postgres"],
    ["socket outside a local dir", "postgresql://%2Fmnt%2Fremote/postgres"],
    ["socket path traversal", "postgresql://%2Ftmp%2F..%2Fmnt/postgres"],
    ["embedded newline", "postgresql://local\nhost/postgres"],
    ["non-postgres protocol", "http://localhost/postgres"],
    ["production ref", "postgresql://localhost/ozuatdcakezjtevztjlr"],
    ["missing", undefined],
  ])("refuses %s", (_label, url) => {
    expect(() => assertProofDatabaseUrl(url)).toThrow(/--prove database URL refused/);
  });
});

describe("ovd979-rollback libpq host view", () => {
  it.each([
    ["localhost:54322/postgres", "localhost"],
    ["postgres:pw@127.0.0.1:5432/postgres", "127.0.0.1"],
    ["postgres@[::1]:5432/postgres", "[::1]"],
    ["localhost?x@db.example.com/postgres", "db.example.com"],
    ["%2Ftmp/postgres", "%2Ftmp"],
  ])("reads %s as host %s", (rest, host) => {
    expect(libpqHost(rest)).toBe(host);
  });
});

describe("ovd979-rollback --prove refuses before spawning psql", () => {
  it.each([
    "postgresql://localhost/postgres?hostaddr=192.0.2.1",
    "postgresql://localhost?x@db.example.com/postgres",
    "postgresql://db.example.com/postgres",
  ])("never runs psql for %s", (url) => {
    const dir = mkdtempSync(join(tmpdir(), "ovd979-prove-"));
    try {
      const marker = join(dir, "psql-ran");
      const fakePsql = join(dir, "psql");
      writeFileSync(fakePsql, `#!/bin/sh\ntouch '${marker}'\n`);
      chmodSync(fakePsql, 0o755);
      const run = spawnSync(process.execPath, [script, migration, "--prove", "--db-url", url], {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", SEED_PSQL_PATH: fakePsql },
      });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toMatch(/--prove database URL refused/);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ovd979-rollback psql environment", () => {
  it("drops every PG* variable and pins PATH", () => {
    const env = proofPsqlEnv({
      PGHOST: "db.example.com",
      PGHOSTADDR: "192.0.2.1",
      PGSERVICE: "prod",
      PGPASSWORD: "secret",
      pgport: "6543",
      HOME: "/home/test",
      SEED_PSQL_PATH: "/opt/psql",
      PATH: "/evil",
    });
    expect(Object.keys(env).filter((key) => /^pg/i.test(key))).toEqual([]);
    expect(env).toEqual({ HOME: "/home/test", SEED_PSQL_PATH: "/opt/psql", PATH: "/usr/bin:/bin" });
  });

  it("does not modify its input", () => {
    const input = { PGHOST: "db.example.com" };
    proofPsqlEnv(input);
    expect(input).toEqual({ PGHOST: "db.example.com" });
  });
});

describe("ovd979-rollback ACL statements", () => {
  it("returns the single-line revoke and grant for a function", () => {
    const sql = "revoke all on function public.f(uuid) from public;\ngrant execute on function public.f(uuid) to service_role;\n";
    expect(aclStatements(sql, "public.f")).toHaveLength(2);
  });

  it("fails when it finds no statement, rather than dropping the ACLs", () => {
    const sql = "grant execute\n  on function public.f(uuid) to service_role;\n";
    expect(() => aclStatements(sql, "public.f")).toThrow(/no single-line revoke\/grant/);
  });
});
