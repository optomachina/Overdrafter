// @vitest-environment node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PRODUCTION_PROJECT_REF,
  PSQL_FIXED_PATH,
  STAGING_PROJECT_REF,
  libpqEnv,
  main,
  psqlArgs,
  refFromDatabaseUrl,
  resolvePsqlBin,
  resolveTargetRef,
} from "./seed-staging.mjs";

const scriptPath = path.resolve(process.cwd(), "scripts/seed-staging.mjs");
const UNKNOWN_REF = "abcdefghijklmnopqrst";
const SECRET = "fixture-not-a-real-password";
const directUrl = (ref) => `postgresql://postgres:${SECRET}@db.${ref}.supabase.co:5432/postgres`;
const poolerUrl = (ref) => `postgresql://postgres.${ref}:${SECRET}@aws-0-us-west-1.pooler.supabase.com:6543/postgres`;

function runScript(args, env = {}) {
  // Only PATH survives, so no ambient SUPABASE_URL can leak in. Every refusal
  // happens before psql starts, so nothing here touches the network.
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...env },
  });
}

function mainWith(argv, env, findPsql = () => ({ ok: true, bin: "/usr/bin/psql" })) {
  const runPsql = vi.fn(() => 0);
  const messages = [];
  const record = (line) => messages.push(line);
  const code = main(argv, env, { runPsql, findPsql, log: record, error: record });
  return { code, runPsql, output: messages.join("\n") };
}

describe("seed-staging target guard (OVD-837)", () => {
  it.each([
    ["--ref", { argv: ["--ref", PRODUCTION_PROJECT_REF], env: {} }],
    ["SUPABASE_URL", { argv: [], env: { SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co` } }],
    ["direct database URL", { argv: [], env: { STAGING_DATABASE_URL: directUrl(PRODUCTION_PROJECT_REF) } }],
    ["pooler database URL", { argv: [], env: { STAGING_DATABASE_URL: poolerUrl(PRODUCTION_PROJECT_REF) } }],
  ])("refuses the production ref from %s without starting psql", (_source, { argv, env }) => {
    const { code, runPsql, output } = mainWith(argv, env);
    expect(code).toBe(1);
    expect(runPsql).not.toHaveBeenCalled();
    expect(output).toContain("PRODUCTION");
    expect(output).not.toContain(SECRET);
  });

  it("refuses an unknown ref, a missing ref, and an underivable database URL", () => {
    for (const [argv, env] of [
      [["--ref", UNKNOWN_REF], {}],
      [[], { STAGING_DATABASE_URL: directUrl(UNKNOWN_REF) }],
      [[], {}],
      [[], { STAGING_DATABASE_URL: `postgresql://postgres:${SECRET}@localhost:5432/postgres` }],
      [["--ref", STAGING_PROJECT_REF], { STAGING_DATABASE_URL: `postgresql://postgres:${SECRET}@127.0.0.1:54322/postgres` }],
    ]) {
      const { code, runPsql, output } = mainWith(argv, env);
      expect(code).toBe(1);
      expect(runPsql).not.toHaveBeenCalled();
      expect(output).not.toContain(SECRET);
    }
  });

  it("refuses when sources disagree, even if one of them is staging", () => {
    expect(resolveTargetRef({ ref: STAGING_PROJECT_REF, env: { STAGING_DATABASE_URL: directUrl(UNKNOWN_REF) } })).toMatchObject({ ok: false });
    expect(resolveTargetRef({ ref: STAGING_PROJECT_REF, env: { SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co` } }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("PRODUCTION") });
    expect(refFromDatabaseUrl(`postgresql://postgres.${STAGING_PROJECT_REF}:x@db.${PRODUCTION_PROJECT_REF}.supabase.co:5432/postgres`)).toBeNull();
  });

  it("accepts only the staging ref and seeds in one transaction", () => {
    const env = { SUPABASE_URL: `https://${STAGING_PROJECT_REF}.supabase.co`, STAGING_DATABASE_URL: poolerUrl(STAGING_PROJECT_REF) };
    const { code, runPsql, output } = mainWith(["--ref", STAGING_PROJECT_REF], env);
    expect(code).toBe(0);
    expect(runPsql.mock.calls.map(([file, , options]) => [path.basename(file), options.singleTransaction])).toEqual([
      ["staging-counts.sql", false],
      ["staging.sql", true],
      ["staging-counts.sql", false],
      ["staging-smoke.sql", false],
    ]);
    for (const [, , options] of runPsql.mock.calls) {
      expect(options).toMatchObject({ targetRef: STAGING_PROJECT_REF, psqlBin: "/usr/bin/psql" });
    }
    expect(output).not.toContain(SECRET);
    expect(libpqEnv(poolerUrl(STAGING_PROJECT_REF))).toMatchObject({ PGUSER: `postgres.${STAGING_PROJECT_REF}`, PGPORT: "6543", PGSSLMODE: "require" });
  });

  it.each([
    ["production", ["--ref", PRODUCTION_PROJECT_REF], {}],
    ["production database URL", [], { STAGING_DATABASE_URL: directUrl(PRODUCTION_PROJECT_REF) }],
    ["unknown", ["--ref", UNKNOWN_REF], {}],
    ["missing", [], {}],
  ])("the runner process exits non-zero for a %s target", (_label, args, env) => {
    const result = runScript(args, env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("seed-staging:");
    expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET);
  });

  it("the runner process passes --check-target for staging only", () => {
    expect(runScript(["--ref", STAGING_PROJECT_REF, "--check-target"]).status).toBe(0);
  });
});

describe("seed-staging psql invocation (OVD-837)", () => {
  const stagingEnv = { STAGING_DATABASE_URL: directUrl(STAGING_PROJECT_REF) };

  it("never looks psql up on the inherited PATH", () => {
    const source = readFileSync(scriptPath, "utf8");
    expect(source).not.toMatch(/process\.env\.PATH/);
    expect(source).not.toMatch(/spawnSync\(\s*["']psql["']/);
    expect(PSQL_FIXED_PATH.split(":").every((dir) => path.isAbsolute(dir))).toBe(true);
  });

  it("uses an absolute PSQL_BIN and refuses a relative one", () => {
    const isExecutable = vi.fn(() => true);
    expect(resolvePsqlBin({ PSQL_BIN: "/custom/pg/bin/psql" }, isExecutable)).toEqual({ ok: true, bin: "/custom/pg/bin/psql" });
    for (const PSQL_BIN of ["psql", "bin/psql", "./psql"]) {
      expect(resolvePsqlBin({ PSQL_BIN }, isExecutable)).toMatchObject({ ok: false, reason: expect.stringContaining("absolute") });
    }
    expect(isExecutable).not.toHaveBeenCalled();
  });

  it("searches only the fixed directories, ignoring PATH", () => {
    const seen = [];
    const isExecutable = (file) => {
      seen.push(file);
      return file === "/opt/homebrew/bin/psql";
    };
    expect(resolvePsqlBin({ PATH: "/tmp/evil" }, isExecutable)).toEqual({ ok: true, bin: "/opt/homebrew/bin/psql" });
    expect(seen.every((file) => path.isAbsolute(file) && !file.startsWith("/tmp/"))).toBe(true);
    expect(resolvePsqlBin({ PATH: "/tmp/evil" }, () => false)).toMatchObject({ ok: false });
  });

  it("refuses before any psql step when psql cannot be resolved", () => {
    const { code, runPsql, output } = mainWith([], { ...stagingEnv, PSQL_BIN: "psql" }, resolvePsqlBin);
    expect(code).toBe(1);
    expect(runPsql).not.toHaveBeenCalled();
    expect(output).toContain("PSQL_BIN must be an absolute path");
  });

  it("asserts the staging ref for the in-SQL guard only inside the seed transaction", () => {
    const seedArgs = psqlArgs("/x/staging.sql", { singleTransaction: true, targetRef: STAGING_PROJECT_REF });
    expect(seedArgs).toContain("--single-transaction");
    const setIndex = seedArgs.indexOf(`set local ovd837.seed_target_ref = '${STAGING_PROJECT_REF}'`);
    expect(setIndex).toBeGreaterThan(0);
    expect(setIndex).toBeLessThan(seedArgs.indexOf("/x/staging.sql"));
    expect(psqlArgs("/x/staging-counts.sql").join(" ")).not.toContain("seed_target_ref");
    for (const targetRef of [PRODUCTION_PROJECT_REF, UNKNOWN_REF, null]) {
      expect(() => psqlArgs("/x/staging.sql", { singleTransaction: true, targetRef })).toThrow();
    }
  });
});

describe("staging seed SQL (OVD-837)", () => {
  // SQL with line comments removed, so prose in the headers is not matched.
  const read = (name) => readFileSync(path.resolve(process.cwd(), "supabase/seed", name), "utf8").replace(/--.*$/gm, "");
  const seed = read("staging.sql");

  it("is one batch for the SQL API: no transaction control or psql meta-commands", () => {
    // A bare `begin` line is the guard's plpgsql block; `begin;` would be transaction control.
    expect(seed).not.toMatch(/^\s*(begin\s*(transaction|work)?\s*;|commit\b|rollback\b|start transaction\b)/im);
    expect(seed).not.toMatch(/^\s*\\/m);
  });

  it("is idempotent and keeps to fixed fixture ids", () => {
    const inserts = seed.match(/insert into/gi) ?? [];
    const guards = seed.match(/on conflict/gi) ?? [];
    expect(inserts.length).toBeGreaterThan(0);
    expect(guards.length).toBe(inserts.length);
    expect(seed).not.toMatch(/gen_random_uuid|uuid_generate/i);
    expect(seed).not.toMatch(/\b(delete|truncate|drop)\b/i);
  });

  it("aborts unless the session asserts the staging ref, before any write", () => {
    const guard = /do \$guard\$([\s\S]*?)\$guard\$;/i.exec(seed);
    expect(guard).not.toBeNull();
    expect(guard.index).toBeLessThan(seed.search(/\b(insert|update)\b/i));
    expect(guard[1]).toContain("current_setting('ovd837.seed_target_ref', true)");
    expect(guard[1]).toContain(`<> '${STAGING_PROJECT_REF}'`);
    expect(guard[1]).toMatch(/raise exception/i);
    expect(seed).not.toContain(PRODUCTION_PROJECT_REF);
  });

  it("recreates a missing kill switch engaged and never releases an existing one", () => {
    for (const table of ["provider_kill_switches", "provider_global_kill_switch"]) {
      const insert = new RegExp(`insert into private\\.${table} \\(([^)]*)\\)([\\s\\S]*?);`, "i").exec(seed);
      expect(insert).not.toBeNull();
      const columns = insert[1].split(",").map((column) => column.trim());
      const engaged = columns.indexOf("engaged");
      expect(engaged).toBeGreaterThan(0);
      const firstRow = /(?:select|values \()\s*([^\n]*)/i.exec(insert[2])[1].split(",").map((value) => value.trim());
      expect(firstRow[engaged]).toBe("true");
      expect(insert[2]).toMatch(/on conflict \(\w+\) do nothing\s*$/i);
      expect(seed).not.toMatch(new RegExp(`update\\s+private\\.${table}`, "i"));
    }
  });

  it("uses only reserved fake email domains", () => {
    const emails = seed.match(/[\w.+-]+@[\w.-]+/g) ?? [];
    expect(emails.length).toBeGreaterThan(0);
    for (const email of emails) expect(email).toMatch(/@example\.(test|com)$/);
  });

  it("keeps the counts and smoke files read only", () => {
    for (const name of ["staging-counts.sql", "staging-smoke.sql"]) {
      expect(read(name)).not.toMatch(/\b(insert|update|delete|truncate|alter|create|drop|grant)\b/i);
    }
    expect(read("staging-smoke.sql")).toMatch(/limit \d+;\s*$/i);
  });
});
