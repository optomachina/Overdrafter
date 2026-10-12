// @vitest-environment node

import { describe, expect, it } from "vitest";
import { findPsql, planBetaAccessFixture } from "./seed-dev.mjs";

const LOCAL_API = "http://127.0.0.1:54321";
const LOCAL_DB = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const REMOTE_API = "https://example-project.supabase.co";
const REMOTE_DB = "postgresql://postgres:secret@db.example-project.supabase.co:5432/postgres";

describe("seed-dev Founding Beta fixture guard", () => {
  it("applies the private fixture only to a local API and database", () => {
    expect(planBetaAccessFixture({ supabaseUrl: LOCAL_API, dbUrl: LOCAL_DB, allowRemote: false })).toEqual({
      apply: true,
      dbUrl: LOCAL_DB,
    });
    expect(
      planBetaAccessFixture({
        supabaseUrl: "http://localhost:54321",
        dbUrl: "postgresql://postgres:postgres@localhost:54322/postgres",
        allowRemote: false,
      }).apply,
    ).toBe(true);
  });

  it.each([
    { supabaseUrl: REMOTE_API, dbUrl: REMOTE_DB },
    { supabaseUrl: REMOTE_API, dbUrl: LOCAL_DB },
    { supabaseUrl: LOCAL_API, dbUrl: LOCAL_DB },
    { supabaseUrl: REMOTE_API, dbUrl: undefined },
  ])("never writes private rows under --allow-remote (%j)", (target) => {
    const plan = planBetaAccessFixture({ ...target, allowRemote: true });

    expect(plan.apply).toBe(false);
    expect(plan).not.toHaveProperty("dbUrl");
    expect(plan.reason).toMatch(/--allow-remote/);
  });

  it("refuses a non-local database URL behind a local API", () => {
    expect(() => planBetaAccessFixture({ supabaseUrl: LOCAL_API, dbUrl: REMOTE_DB, allowRemote: false })).toThrow(
      /Refusing to write Founding Beta fixture rows to non-local database db\.example-project\.supabase\.co/,
    );
  });

  it("refuses a non-local API even when the database URL is local", () => {
    expect(() => planBetaAccessFixture({ supabaseUrl: REMOTE_API, dbUrl: LOCAL_DB, allowRemote: false })).toThrow(
      /non-local Supabase project/,
    );
  });

  it("fails loudly when a local seed has no database URL", () => {
    expect(() => planBetaAccessFixture({ supabaseUrl: LOCAL_API, dbUrl: undefined, allowRemote: false })).toThrow(
      /DB_URL/,
    );
  });

  it.each([
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres?host=db.example-project.supabase.co",
    "postgresql://postgres:postgres@localhost:54322/postgres?hostaddr=203.0.113.9",
    "postgresql://postgres:postgres@localhost:54322/postgres?sslmode=disable&HOST=db.example.com",
  ])("refuses a local looking URL that overrides the host by query parameter (%s)", (dbUrl) => {
    expect(() => planBetaAccessFixture({ supabaseUrl: LOCAL_API, dbUrl, allowRemote: false })).toThrow(
      /host(addr)? query parameter/i,
    );
  });

  it("still accepts harmless query parameters on a local URL", () => {
    expect(
      planBetaAccessFixture({
        supabaseUrl: LOCAL_API,
        dbUrl: `${LOCAL_DB}?sslmode=disable`,
        allowRemote: false,
      }).apply,
    ).toBe(true);
  });
});

describe("seed-dev psql resolution", () => {
  it("uses SEED_PSQL_PATH when it names an existing absolute binary", () => {
    expect(findPsql({ SEED_PSQL_PATH: process.execPath })).toBe(process.execPath);
  });

  it.each([{ SEED_PSQL_PATH: "psql" }, { SEED_PSQL_PATH: "/definitely/not/here/psql" }])(
    "rejects an override that is relative or missing (%j)",
    (env) => {
      expect(() => findPsql(env)).toThrow(/SEED_PSQL_PATH must be an absolute path/);
    },
  );
});
