// @vitest-environment node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PRODUCTION_PROJECT_REF,
  STAGING_PROJECT_REF,
  libpqEnv,
  main,
  refFromDatabaseUrl,
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

function mainWith(argv, env) {
  const runPsql = vi.fn(() => 0);
  const messages = [];
  const code = main(argv, env, { runPsql, log: (line) => messages.push(line), error: (line) => messages.push(line) });
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

describe("staging seed SQL (OVD-837)", () => {
  // SQL with line comments removed, so prose in the headers is not matched.
  const read = (name) => readFileSync(path.resolve(process.cwd(), "supabase/seed", name), "utf8").replace(/--.*$/gm, "");
  const seed = read("staging.sql");

  it("is one batch for the SQL API: no transaction control or psql meta-commands", () => {
    expect(seed).not.toMatch(/^\s*(begin|commit|rollback|start transaction)\b/im);
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
