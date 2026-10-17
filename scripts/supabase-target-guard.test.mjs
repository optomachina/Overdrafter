// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  ALLOWED_REMOTE_REFS,
  PRODUCTION_PROJECT_REF,
  TargetRefusedError,
  assertAllowedTarget,
  assertLocalDatabaseUrl,
} from "./supabase-target-guard.mjs";

describe("supabase target guard", () => {
  it("refuses the production ref in any casing or padding", () => {
    for (const ref of [PRODUCTION_PROJECT_REF, ` ${PRODUCTION_PROJECT_REF} `, PRODUCTION_PROJECT_REF.toUpperCase()]) {
      expect(() => assertAllowedTarget(ref)).toThrow(TargetRefusedError);
      expect(() => assertAllowedTarget(ref)).toThrow(/production/);
    }
  });

  it("refuses production even when someone adds it to the allowlist", () => {
    expect(() => assertAllowedTarget(PRODUCTION_PROJECT_REF, { allowlist: [PRODUCTION_PROJECT_REF] })).toThrow(/production/);
  });

  it("refuses unknown remote refs while the allowlist is empty", () => {
    expect(ALLOWED_REMOTE_REFS).toEqual([]);
    expect(() => assertAllowedTarget("abcdefghijklmnopqrst")).toThrow(/not in the allowlist/);
  });

  it("refuses missing and malformed refs", () => {
    for (const ref of [undefined, null, "", "   ", 42, "staging", "abc123", "https://abcdefghijklmnopqrst.supabase.co"]) {
      expect(() => assertAllowedTarget(ref)).toThrow(TargetRefusedError);
    }
  });

  it("allows local and ephemeral targets", () => {
    expect(assertAllowedTarget("local")).toEqual({ kind: "local", ref: "local" });
    expect(assertAllowedTarget("ephemeral")).toEqual({ kind: "local", ref: "ephemeral" });
  });

  it("allows an allowlisted remote ref (the OVD-836 staging shape)", () => {
    expect(assertAllowedTarget("abcdefghijklmnopqrst", { allowlist: ["abcdefghijklmnopqrst"] }))
      .toEqual({ kind: "remote", ref: "abcdefghijklmnopqrst" });
  });

  it("accepts only loopback database URLs", () => {
    expect(assertLocalDatabaseUrl("postgresql://postgres:postgres@127.0.0.1:54322/postgres").hostname).toBe("127.0.0.1");
    expect(assertLocalDatabaseUrl("postgres://postgres:postgres@localhost:54322/postgres").hostname).toBe("localhost");
    for (const url of [
      `postgresql://postgres:pw@db.${PRODUCTION_PROJECT_REF}.supabase.co:5432/postgres`,
      "postgresql://postgres:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
      `postgresql://postgres.${PRODUCTION_PROJECT_REF}:pw@127.0.0.1:54322/postgres`,
      "mysql://root@127.0.0.1/db",
      "not a url",
    ]) {
      expect(() => assertLocalDatabaseUrl(url)).toThrow(TargetRefusedError);
    }
  });
});
