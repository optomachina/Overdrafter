// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  PRODUCTION_PROJECT_REF,
  STAGING_PROJECT_REF,
  STAGING_REF_ALLOWLIST,
  StagingTargetRefusedError,
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

  it.each([
    `https://${STAGING_PROJECT_REF}.supabase.co`,
    `postgresql://postgres:secret@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres`,
    `postgresql://postgres.${STAGING_PROJECT_REF}:secret@aws-0-us-west-1.pooler.supabase.com:5432/postgres`,
  ])("accepts staging URL %s", (target) => {
    expect(assertStagingTarget(target)).toBe(STAGING_PROJECT_REF);
  });

  it.each([
    `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
    `postgresql://postgres:secret@db.${PRODUCTION_PROJECT_REF}.supabase.co:5432/postgres`,
    `postgresql://postgres.${PRODUCTION_PROJECT_REF}:secret@aws-0-us-west-1.pooler.supabase.com:5432/postgres`,
    `postgresql://postgres.${STAGING_PROJECT_REF}:secret@db.${PRODUCTION_PROJECT_REF}.supabase.co:5432/postgres`,
    `postgresql://postgres:secret@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres?options=${PRODUCTION_PROJECT_REF}`,
  ])("refuses production-bearing URL %s", (target) => {
    expect(() => assertStagingTarget(target)).toThrow(StagingTargetRefusedError);
  });

  it.each([
    "postgresql://postgres:secret@127.0.0.1:54322/postgres",
    "https://abcdefghijklmnopqrst.supabase.co",
    "not a target",
  ])("refuses unknown or local target %s", (target) => {
    expect(() => assertStagingTarget(target)).toThrow(StagingTargetRefusedError);
  });

  const stagingDbUrl = `postgresql://postgres:secret@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres`;
  const stagingPoolerUrl = `postgresql://postgres.${STAGING_PROJECT_REF}:secret@aws-0-us-west-1.pooler.supabase.com:6543/postgres`;

  it.each([
    `${stagingDbUrl}?sslmode=require`,
    `${stagingPoolerUrl}?sslmode=require&application_name=staging-seed`,
  ])("still accepts a staging URL with ordinary query parameters %s", (target) => {
    expect(assertStagingTarget(target)).toBe(STAGING_PROJECT_REF);
  });

  it.each([
    [`${stagingDbUrl}?host=evil.example.com`, "host"],
    [`${stagingDbUrl}?hostaddr=1.2.3.4`, "hostaddr"],
    [`${stagingDbUrl}?HOST=evil.example.com`, "host"],
    [`${stagingDbUrl}?HostAddr=1.2.3.4`, "hostaddr"],
    [`${stagingDbUrl}?sslmode=require&host=%2Ftmp`, "host"],
    [`${stagingDbUrl}?%68ost=evil.example.com`, "host"],
    [`${stagingPoolerUrl}?host=db.${PRODUCTION_PROJECT_REF}.supabase.co`, "host"],
  ])("refuses a URL whose query overrides the host %s", (target, param) => {
    expect(() => assertStagingTarget(target)).toThrow(StagingTargetRefusedError);
    expect(() => assertStagingTarget(target)).toThrow(`${param} parameter`);
  });

  it.each([
    `postgresql://postgres:secret@db.${STAGING_PROJECT_REF}.supabase.co,evil.example.com/postgres`,
    `postgresql://postgres:secret@db.${STAGING_PROJECT_REF}.supabase.co:5432,evil.example.com:5432/postgres`,
    `postgresql://postgres.${STAGING_PROJECT_REF}:secret@aws-0-us-west-1.pooler.supabase.com,1.2.3.4/postgres`,
  ])("refuses a multi-host URL %s", (target) => {
    expect(() => assertStagingTarget(target)).toThrow(StagingTargetRefusedError);
  });

  it.each([
    `host=db.${STAGING_PROJECT_REF}.supabase.co dbname=postgres user=postgres`,
    `host=db.${STAGING_PROJECT_REF}.supabase.co hostaddr=1.2.3.4 dbname=postgres`,
  ])("refuses a key=value DSN %s", (target) => {
    expect(() => assertStagingTarget(target)).toThrow(StagingTargetRefusedError);
  });

  it("refuses a pooler-style user on a non-Supabase host", () => {
    expect(() =>
      assertStagingTarget(`postgresql://postgres.${STAGING_PROJECT_REF}:secret@evil.example.com:5432/postgres`),
    ).toThrow("not a Supabase pooler");
  });

  it("CLI exits 0 for staging, 1 for production or unknown, 2 for usage", () => {
    const io = { log: vi.fn(), error: vi.fn() };
    expect(main([STAGING_PROJECT_REF], io)).toBe(0);
    expect(main([PRODUCTION_PROJECT_REF], io)).toBe(1);
    expect(main(["abcdefghijklmnopqrst"], io)).toBe(1);
    expect(main([], io)).toBe(2);
    expect(main([STAGING_PROJECT_REF, PRODUCTION_PROJECT_REF], io)).toBe(2);
  });

  it("CLI never echoes a connection string password", () => {
    const io = { log: vi.fn(), error: vi.fn() };
    main([`postgresql://postgres:hunter2@db.${PRODUCTION_PROJECT_REF}.supabase.co:5432/postgres`], io);
    main([`postgresql://postgres:hunter2@db.${STAGING_PROJECT_REF}.supabase.co:5432/postgres`], io);
    const output = [...io.log.mock.calls, ...io.error.mock.calls].flat().join("\n");
    expect(output).not.toContain("hunter2");
  });
});
