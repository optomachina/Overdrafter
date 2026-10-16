// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  PRODUCTION_PROJECT_REF,
  STAGING_PROJECT_REF,
  REFUSED_CONNECTION_ENV_VARS,
  STAGING_CONNECTION_URL_PATTERN,
  STAGING_DIRECT_HOST,
  STAGING_POOLER_HOST,
  STAGING_REF_ALLOWLIST,
  StagingTargetRefusedError,
  assertStagingConnectionEnv,
  assertStagingRef,
  assertStagingTarget,
  main,
} from "./staging-reset-guard.mjs";

describe("staging reset guard", () => {
  it("allowlists exactly the documented staging ref", () => {
    expect(STAGING_REF_ALLOWLIST).toEqual(["ldmambwtksfvqdufhaam"]);
    expect(Object.isFrozen(STAGING_REF_ALLOWLIST)).toBe(true);
  });

  it("accepts the staging ref", () => {
    expect(assertStagingRef(STAGING_PROJECT_REF)).toBe(STAGING_PROJECT_REF);
  });

  it("refuses the production ref", () => {
    expect(() => assertStagingRef(PRODUCTION_PROJECT_REF)).toThrow(StagingTargetRefusedError);
    expect(() => assertStagingRef("ozuatdcakezjtevztjlr")).toThrow("production project");
  });

  it.each(["abcdefghijklmnopqrst", "ldmambwtksfvqdufhaab"])("refuses unknown ref %s", (ref) => {
    expect(() => assertStagingRef(ref)).toThrow("not the documented staging project");
  });

  it.each([undefined, null, "", " ldmambwtksfvqdufhaam", "LDMAMBWTKSFVQDUFHAAM", "ldmambwtksfvqdufhaam\n"])(
    "refuses malformed ref %j",
    (ref) => {
      expect(() => assertStagingRef(ref)).toThrow(StagingTargetRefusedError);
    },
  );

  const stagingDirectUrl = `postgres://postgres:pw@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres?sslmode=require`;
  const stagingPoolerUrl = `postgresql://postgres.${STAGING_PROJECT_REF}:pw%40x@aws-1-us-west-1.pooler.supabase.com:6543/postgres`;

  it.each([
    stagingDirectUrl,
    stagingPoolerUrl,
    `postgresql://postgres:pw@db.${STAGING_PROJECT_REF}.supabase.co:6543/postgres`,
    `postgresql://postgres.${STAGING_PROJECT_REF}:A-z_0.9~%2F%3a@aws-1-us-west-1.pooler.supabase.com:5432/postgres?sslmode=verify-full`,
  ])("accepts staging URL %s", (target) => {
    expect(assertStagingTarget(target)).toBe(STAGING_PROJECT_REF);
  });

  it("STAGING_CONNECTION_URL_PATTERN is anchored to the exported hosts", () => {
    expect(STAGING_CONNECTION_URL_PATTERN.source.startsWith("^")).toBe(true);
    expect(STAGING_CONNECTION_URL_PATTERN.source.endsWith("$")).toBe(true);
    expect(STAGING_DIRECT_HOST).toBe(`db.${STAGING_PROJECT_REF}.supabase.co`);
    expect(STAGING_POOLER_HOST).toBe("aws-1-us-west-1.pooler.supabase.com");
  });

  it.each([
    // Node's URL() and libpq disagree on the host when # or ? precedes the last @.
    `postgresql://db.${STAGING_PROJECT_REF}.supabase.co#@evil.example.com/postgres`,
    `postgresql://db.${STAGING_PROJECT_REF}.supabase.co?@evil.example.com/postgres`,
    `postgresql://postgres:pw@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres#@evil.example.com`,
    `postgresql://postgres:pw@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres?sslmode=require#x`,
  ])("refuses a fragment or query-before-@ parser confusion URL %s", (target) => {
    expect(() => assertStagingTarget(target)).toThrow(StagingTargetRefusedError);
  });

  it.each([
    ["IPv6 bracket host", "postgresql://postgres:pw@[::1]:5432/postgres"],
    ["service param", `${stagingDirectUrl.replace("?sslmode=require", "")}?service=x`],
    ["host param", `${stagingDirectUrl.replace("?sslmode=require", "")}?host=evil`],
    ["hostaddr param", `${stagingDirectUrl}&hostaddr=1.2.3.4`],
    ["extra query param", `${stagingDirectUrl}&application_name=staging-seed`],
    ["other sslmode", `postgresql://postgres:pw@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres?sslmode=disable`],
    ["raw @ in password", `postgresql://postgres:p@w@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres`],
    ["raw # in password", `postgresql://postgres:p#w@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres`],
    ["raw : in password", `postgresql://postgres:p:w@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres`],
    ["bad percent escape", `postgresql://postgres:p%zzw@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres`],
    ["empty password", `postgresql://postgres:@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres`],
    ["no password", `postgresql://postgres@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres`],
    ["prod ref in host", `postgresql://postgres:pw@db.${PRODUCTION_PROJECT_REF}.supabase.co:5432/postgres`],
    [
      "prod ref in pooler user",
      `postgresql://postgres.${PRODUCTION_PROJECT_REF}:pw@aws-1-us-west-1.pooler.supabase.com:6543/postgres`,
    ],
    ["wrong port", `postgresql://postgres:pw@db.${STAGING_PROJECT_REF}.supabase.co:5433/postgres`],
    ["missing port", `postgresql://postgres:pw@db.${STAGING_PROJECT_REF}.supabase.co/postgres`],
    ["wrong direct user", `postgresql://admin:pw@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres`],
    ["pooler user on direct host", `postgresql://postgres.${STAGING_PROJECT_REF}:pw@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres`],
    ["direct user on pooler host", "postgresql://postgres:pw@aws-1-us-west-1.pooler.supabase.com:6543/postgres"],
    ["old aws-0 pooler host", `postgresql://postgres.${STAGING_PROJECT_REF}:pw@aws-0-us-west-1.pooler.supabase.com:6543/postgres`],
    ["wrong database", `postgresql://postgres:pw@db.${STAGING_PROJECT_REF}.supabase.co:5432/template1`],
    ["multi-host", `postgresql://postgres:pw@db.${STAGING_PROJECT_REF}.supabase.co:5432,evil.example.com:5432/postgres`],
    ["uppercase host", `postgresql://postgres:pw@DB.${STAGING_PROJECT_REF.toUpperCase()}.SUPABASE.CO:5432/postgres`],
    ["trailing newline", `postgresql://postgres:pw@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres\n`],
    ["pooler user on foreign host", `postgresql://postgres.${STAGING_PROJECT_REF}:pw@evil.example.com:5432/postgres`],
    ["API URL", `https://${STAGING_PROJECT_REF}.supabase.co`],
    ["key=value DSN", `host=db.${STAGING_PROJECT_REF}.supabase.co dbname=postgres user=postgres`],
    ["local URL", "postgresql://postgres:pw@127.0.0.1:54322/postgres"],
    ["not a target", "not a target"],
  ])("refuses %s", (_label, target) => {
    expect(() => assertStagingTarget(target)).toThrow(StagingTargetRefusedError);
  });

  it.each(["PGHOST", "PGHOSTADDR", "PGPORT", "PGSERVICE", "PGSERVICEFILE", "PGPASSFILE"])(
    "refuses when %s is set in the environment",
    (name) => {
      expect(REFUSED_CONNECTION_ENV_VARS).toContain(name);
      expect(() => assertStagingConnectionEnv({ [name]: "" })).toThrow(StagingTargetRefusedError);
      expect(() => assertStagingConnectionEnv({ [name]: "x" })).toThrow(name);
      const io = { log: vi.fn(), error: vi.fn() };
      expect(main([stagingDirectUrl], io, { [name]: "x" })).toBe(1);
    },
  );

  it("accepts an environment without connection overrides", () => {
    expect(() => assertStagingConnectionEnv({ PGUSER: "postgres", PATH: "/usr/bin" })).not.toThrow();
    const io = { log: vi.fn(), error: vi.fn() };
    expect(main([stagingPoolerUrl], io, {})).toBe(0);
  });

  it("CLI exits 0 for staging, 1 for production or unknown, 2 for usage", () => {
    const io = { log: vi.fn(), error: vi.fn() };
    expect(main([STAGING_PROJECT_REF], io, {})).toBe(0);
    expect(main([PRODUCTION_PROJECT_REF], io, {})).toBe(1);
    expect(main(["abcdefghijklmnopqrst"], io, {})).toBe(1);
    expect(main([], io, {})).toBe(2);
    expect(main([STAGING_PROJECT_REF, PRODUCTION_PROJECT_REF], io, {})).toBe(2);
  });

  it("CLI never echoes a connection string password", () => {
    const io = { log: vi.fn(), error: vi.fn() };
    main([`postgresql://postgres:hunter2@db.${PRODUCTION_PROJECT_REF}.supabase.co:5432/postgres`], io, {});
    main([`postgresql://postgres:hunter2@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres`], io, {});
    main([`postgresql://postgres:hunter2@evil.example.com:5432/postgres`], io, {});
    main([`postgresql://postgres:hunter2@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres`], io, { PGHOST: "x" });
    const output = [...io.log.mock.calls, ...io.error.mock.calls].flat().join("\n");
    expect(output).not.toContain("hunter2");
  });
});
