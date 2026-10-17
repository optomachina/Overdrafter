// @vitest-environment node
// OVD-879: static checks for the staging environment sentinel. The seed refuses
// to write unless the staging-only marker row exists, and only
// supabase/staging/bootstrap-marker.sql may create that marker.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const BOOTSTRAP = "supabase/staging/bootstrap-marker.sql";
// SQL with line comments removed, so prose in the headers is not matched.
const stripComments = (sql) => sql.replace(/--.*$/gm, "");
const readRaw = (relative) => readFileSync(path.resolve(root, relative), "utf8");
const read = (relative) => stripComments(readRaw(relative));

function listFiles(dir) {
  return readdirSync(path.resolve(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(relative) : [relative];
  });
}
const sqlFiles = (dir) => listFiles(dir).filter((file) => file.endsWith(".sql"));

describe("staging seed environment sentinel (OVD-879)", () => {
  const seed = read("supabase/seed/staging.sql");
  const sentinel = /do \$sentinel\$([\s\S]*?)\$sentinel\$;/i.exec(seed);

  it("is the first statement, before any insert, update, delete or create", () => {
    expect(sentinel).not.toBeNull();
    expect(seed.trimStart().startsWith(sentinel[0])).toBe(true);
    expect(sentinel.index).toBeLessThan(seed.search(/\b(insert|update|delete|create)\b/i));
    // The OVD-837 ref guard stays, after the sentinel and before any write.
    const guard = seed.search(/do \$guard\$/i);
    expect(guard).toBeGreaterThan(sentinel.index);
    expect(guard).toBeLessThan(seed.search(/\b(insert|update|delete|create)\b/i));
  });

  it("raises STAGING_SENTINEL_MISSING unless the staging marker row exists", () => {
    const body = sentinel[1];
    expect(body).toContain("to_regclass('overdrafter.environment_marker') is not null");
    // Dynamic SQL, so a missing table is never resolved at parse time.
    expect(body).toMatch(/execute\s+'select exists \(select 1 from overdrafter\.environment_marker where env = ''staging''\)'/i);
    expect(body).toMatch(/raise exception 'STAGING_SENTINEL_MISSING/);
    expect(body.replace(/'(?:[^']|'')*'/g, "")).not.toMatch(/\boverdrafter\.environment_marker\b/);
  });

  it("never creates or writes the marker", () => {
    expect(seed).not.toMatch(/\b(create|insert|update|delete|alter|drop|truncate|grant|revoke)\b[^;]*\b(overdrafter|environment_marker)\b/i);
  });
});

describe("staging environment marker bootstrap (OVD-879)", () => {
  const bootstrap = read(BOOTSTRAP);

  it("creates a staging-only marker row idempotently", () => {
    expect(bootstrap).toMatch(/create schema if not exists overdrafter;/i);
    expect(bootstrap).toMatch(/create table if not exists overdrafter\.environment_marker \(/i);
    expect(bootstrap).toMatch(/env text primary key check \(env = 'staging'\)/i);
    expect(bootstrap).toMatch(/created_at timestamptz not null default now\(\)/i);
    expect(bootstrap).toMatch(/insert into overdrafter\.environment_marker \(env\)\s+values \('staging'\)\s+on conflict do nothing;/i);
  });

  it("enables RLS with no policies and revokes every API role", () => {
    expect(bootstrap).toMatch(/alter table overdrafter\.environment_marker enable row level security;/i);
    expect(bootstrap).not.toMatch(/\b(create policy|grant)\b/i);
    expect(bootstrap).toMatch(/revoke all on schema overdrafter from public;/i);
    expect(bootstrap).toMatch(/revoke all on table overdrafter\.environment_marker from public;/i);
    // anon/authenticated revokes are guarded so plain Postgres without them works.
    expect(bootstrap).toMatch(/array\['anon', 'authenticated'\]/);
    expect(bootstrap).toMatch(/from pg_catalog\.pg_roles where rolname = api_role/);
    expect(bootstrap).toContain("revoke all on schema overdrafter from %I");
    expect(bootstrap).toContain("revoke all on table overdrafter.environment_marker from %I");
  });

  it("is the only SQL under supabase/ that creates or writes the marker", () => {
    const writers = sqlFiles("supabase").filter((file) =>
      /\b(create|insert)\b[^;]*\b(overdrafter\.environment_marker|schema (if not exists )?overdrafter)\b/i.test(read(file)));
    expect(writers).toEqual([BOOTSTRAP]);
  });

  it("is never a migration: no migration mentions the marker", () => {
    const migrations = listFiles("supabase/migrations");
    expect(migrations.length).toBeGreaterThan(0);
    for (const file of migrations) {
      expect(readRaw(file), file).not.toMatch(/environment_marker/i);
    }
  });
});
