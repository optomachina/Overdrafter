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
