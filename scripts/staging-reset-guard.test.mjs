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

  const ssl = "?sslmode=require";
  const directBase = `postgresql://postgres:pw@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres`;
  const poolerBase = `postgresql://postgres.${STAGING_PROJECT_REF}:pw%40x@aws-0-us-west-1.pooler.supabase.com:6543/postgres`;
  const stagingDirectUrl = `postgres://postgres:pw@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres${ssl}`;
  const stagingPoolerUrl = `${poolerBase}${ssl}`;

  it.each([
    stagingDirectUrl,
    stagingPoolerUrl,
    `postgresql://postgres:pw@db.${STAGING_PROJECT_REF}.supabase.co:6543/postgres${ssl}`,
    `postgresql://postgres.${STAGING_PROJECT_REF}:A-z_0.9~%2F%3a@aws-0-us-west-1.pooler.supabase.com:5432/postgres?sslmode=verify-full`,
  ])("accepts staging URL %s", (target) => {
    expect(assertStagingTarget(target)).toBe(STAGING_PROJECT_REF);
  });

  it.each([
    ["direct", "require", `${directBase}?sslmode=require`],
    ["direct", "verify-full", `${directBase}?sslmode=verify-full`],
    ["pooler", "require", `${poolerBase}?sslmode=require`],
    ["pooler", "verify-full", `${poolerBase}?sslmode=verify-full`],
  ])("accepts the %s host with sslmode=%s", (_host, _mode, target) => {
    expect(assertStagingTarget(target)).toBe(STAGING_PROJECT_REF);
    const io = { log: vi.fn(), error: vi.fn() };
    expect(main([target], io, {})).toBe(0);
  });

  it.each([
    ["direct, no query", directBase],
    ["pooler, no query", poolerBase],
    ["direct, empty query", `${directBase}?`],
    ["sslmode=disable", `${directBase}?sslmode=disable`],
    ["sslmode=prefer", `${directBase}?sslmode=prefer`],
    ["sslmode=allow", `${directBase}?sslmode=allow`],
    ["sslmode=verify-ca", `${poolerBase}?sslmode=verify-ca`],
    ["empty sslmode", `${directBase}?sslmode=`],
    ["options alone", `${directBase}?options=-c%20search_path%3Devil`],
    ["options after sslmode", `${directBase}?sslmode=require&options=-c%20search_path%3Devil`],
    ["options before sslmode", `${poolerBase}?options=-c%20statement_timeout%3D0&sslmode=require`],
    ["duplicate sslmode", `${directBase}?sslmode=require&sslmode=disable`],
  ])("refuses a missing, weak or extended sslmode query: %s", (_label, target) => {
    expect(() => assertStagingTarget(target)).toThrow(StagingTargetRefusedError);
    const io = { log: vi.fn(), error: vi.fn() };
    expect(main([target], io, {})).toBe(1);
  });

  it("STAGING_CONNECTION_URL_PATTERN is anchored to the exported hosts", () => {
    expect(STAGING_CONNECTION_URL_PATTERN.source.startsWith("^")).toBe(true);
    expect(STAGING_CONNECTION_URL_PATTERN.source.endsWith("$")).toBe(true);
    expect(STAGING_DIRECT_HOST).toBe(`db.${STAGING_PROJECT_REF}.supabase.co`);
    expect(STAGING_POOLER_HOST).toBe("aws-0-us-west-1.pooler.supabase.com");
  });

  it.each([
    // Node's URL() and libpq disagree on the host when # or ? precedes the last @.
    `postgresql://db.${STAGING_PROJECT_REF}.supabase.co#@evil.example.com/postgres${ssl}`,
    `postgresql://db.${STAGING_PROJECT_REF}.supabase.co?@evil.example.com/postgres${ssl}`,
    `${directBase}#@evil.example.com${ssl}`,
    `${directBase}${ssl}#x`,
  ])("refuses a fragment or query-before-@ parser confusion URL %s", (target) => {
    expect(() => assertStagingTarget(target)).toThrow(StagingTargetRefusedError);
  });

  // Every fixture carries sslmode=require so it is refused for its own reason.
  it.each([
    ["IPv6 bracket host", `postgresql://postgres:pw@[::1]:5432/postgres${ssl}`],
    ["service param", `${directBase}?service=x`],
    ["host param", `${directBase}?host=evil`],
    ["hostaddr param", `${stagingDirectUrl}&hostaddr=1.2.3.4`],
    ["target_session_attrs param", `${stagingDirectUrl}&target_session_attrs=read-write`],
    ["extra query param", `${stagingDirectUrl}&application_name=staging-seed`],
    ["raw @ in password", `postgresql://postgres:p@w@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres${ssl}`],
    ["raw # in password", `postgresql://postgres:p#w@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres${ssl}`],
    ["raw : in password", `postgresql://postgres:p:w@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres${ssl}`],
    ["bad percent escape", `postgresql://postgres:p%zzw@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres${ssl}`],
    ["empty password", `postgresql://postgres:@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres${ssl}`],
    ["no password", `postgresql://postgres@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres${ssl}`],
    ["prod ref in host", `postgresql://postgres:pw@db.${PRODUCTION_PROJECT_REF}.supabase.co:5432/postgres${ssl}`],
    [
      "prod ref in pooler user",
      `postgresql://postgres.${PRODUCTION_PROJECT_REF}:pw@aws-0-us-west-1.pooler.supabase.com:6543/postgres${ssl}`,
    ],
    ["wrong port", `postgresql://postgres:pw@db.${STAGING_PROJECT_REF}.supabase.co:5433/postgres${ssl}`],
    ["missing port", `postgresql://postgres:pw@db.${STAGING_PROJECT_REF}.supabase.co/postgres${ssl}`],
    ["wrong direct user", `postgresql://admin:pw@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres${ssl}`],
    [
      "pooler user on direct host",
      `postgresql://postgres.${STAGING_PROJECT_REF}:pw@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres${ssl}`,
    ],
    ["direct user on pooler host", `postgresql://postgres:pw@aws-0-us-west-1.pooler.supabase.com:6543/postgres${ssl}`],
    [
      // OVD-880 probe: aws-1 answers "tenant/user not found" for the staging
      // tenant; it is the prod-only ovd373 tool's cluster. Keep it refused so
      // the old host cannot come back silently.
      "aws-1 pooler host with the staging tenant user",
      `postgresql://postgres.${STAGING_PROJECT_REF}:pw@aws-1-us-west-1.pooler.supabase.com:6543/postgres${ssl}`,
    ],
    [
      "aws-1 pooler host with the staging tenant user, port 5432",
      `postgresql://postgres.${STAGING_PROJECT_REF}:pw@aws-1-us-west-1.pooler.supabase.com:5432/postgres?sslmode=verify-full`,
    ],
    [
      "other aws-N pooler host with the staging tenant user",
      `postgresql://postgres.${STAGING_PROJECT_REF}:pw@aws-2-us-west-1.pooler.supabase.com:6543/postgres${ssl}`,
    ],
    ["wrong database", `postgresql://postgres:pw@db.${STAGING_PROJECT_REF}.supabase.co:5432/template1${ssl}`],
    [
      "multi-host",
      `postgresql://postgres:pw@db.${STAGING_PROJECT_REF}.supabase.co:5432,evil.example.com:5432/postgres${ssl}`,
    ],
    [
      "uppercase host",
      `postgresql://postgres:pw@DB.${STAGING_PROJECT_REF.toUpperCase()}.SUPABASE.CO:5432/postgres${ssl}`,
    ],
    ["uppercase sslmode", `${directBase}?SSLMODE=REQUIRE`],
    ["trailing newline", `${stagingDirectUrl}\n`],
    ["pooler user on foreign host", `postgresql://postgres.${STAGING_PROJECT_REF}:pw@evil.example.com:5432/postgres${ssl}`],
    ["API URL", `https://${STAGING_PROJECT_REF}.supabase.co`],
    ["key=value DSN", `host=db.${STAGING_PROJECT_REF}.supabase.co dbname=postgres user=postgres sslmode=require`],
    ["local URL", `postgresql://postgres:pw@127.0.0.1:54322/postgres${ssl}`],
    ["not a target", "not a target"],
  ])("refuses %s", (_label, target) => {
    expect(() => assertStagingTarget(target)).toThrow(StagingTargetRefusedError);
  });

  it("refuses exactly the ten libpq connection override variables", () => {
    expect(REFUSED_CONNECTION_ENV_VARS).toEqual([
      "PGHOST",
      "PGHOSTADDR",
      "PGPORT",
      "PGSERVICE",
      "PGSERVICEFILE",
      "PGPASSFILE",
      "PGSSLMODE",
      "PGOPTIONS",
      "PGSSLROOTCERT",
      "PGTARGETSESSIONATTRS",
    ]);
    expect(Object.isFrozen(REFUSED_CONNECTION_ENV_VARS)).toBe(true);
  });

  it.each([
    "PGHOST",
    "PGHOSTADDR",
    "PGPORT",
    "PGSERVICE",
    "PGSERVICEFILE",
    "PGPASSFILE",
    "PGSSLMODE",
    "PGOPTIONS",
    "PGSSLROOTCERT",
    "PGTARGETSESSIONATTRS",
  ])("refuses when %s is set in the environment", (name) => {
    expect(REFUSED_CONNECTION_ENV_VARS).toContain(name);
    expect(() => assertStagingConnectionEnv({ [name]: "" })).toThrow(StagingTargetRefusedError);
    expect(() => assertStagingConnectionEnv({ [name]: "x" })).toThrow(name);
    const io = { log: vi.fn(), error: vi.fn() };
    expect(main([stagingDirectUrl], io, { [name]: "x" })).toBe(1);
    expect(main([stagingPoolerUrl], io, { [name]: "" })).toBe(1);
    expect(io.log).not.toHaveBeenCalled();
  });

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
    main([`postgresql://postgres:hunter2@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres${ssl}`], io, { PGSSLMODE: "disable" });
    const output = [...io.log.mock.calls, ...io.error.mock.calls].flat().join("\n");
    expect(output).not.toContain("hunter2");
  });
});
