// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { reportSupplierCartCleanup, supplierCartCleanupFromPayload } from "./liveHarnessSupplierCleanup";

describe("live harness supplier cart cleanup record (standing rule, 2026-10-15)", () => {
  it("records a confirmed removal as info", () => {
    const log = vi.fn();
    const record = reportSupplierCartCleanup({
      vendor: "oshcut",
      quantity: 3,
      payload: { providerMutationPossible: true, cartCleanup: { status: "removed", removed: 1, remaining: 0, reason: null } },
    }, log);
    expect(record).toEqual({ status: "removed", removed: 1, remaining: 0, reason: null, manualRemovalRequired: false });
    const [line, warn] = log.mock.calls[0]!;
    expect(warn).toBe(false);
    expect(JSON.parse(line)).toMatchObject({ level: "info", source: "liveHarnessSupplierCleanup", vendor: "oshcut", quantity: 3 });
  });

  it.each([
    ["incomplete", { status: "incomplete", removed: 0, remaining: 1, reason: null }],
    ["failed", { status: "failed", removed: 0, remaining: null, reason: "CleanupTimeout" }],
    ["not_found", { status: "not_found", removed: 0, remaining: 0, reason: null }],
    ["skipped_kill_switch", { status: "skipped_kill_switch", removed: 0, remaining: null, reason: "ProviderKillSwitchError" }],
  ])("warns for manual removal when cleanup reports %s", (status, cartCleanup) => {
    const log = vi.fn();
    const record = reportSupplierCartCleanup({ vendor: "oshcut", quantity: 1, payload: { cartCleanup } }, log);
    expect(record).toMatchObject({ status, manualRemovalRequired: true });
    const [line, warn] = log.mock.calls[0]!;
    expect(warn).toBe(true);
    expect(JSON.parse(line)).toMatchObject({ level: "warn", action: expect.stringContaining("manually") });
  });

  it("flags an upload by an adapter that declares no cleanup", () => {
    expect(supplierCartCleanupFromPayload({ providerMutationPossible: true })).toMatchObject({
      status: "not_declared", manualRemovalRequired: true,
    });
  });

  it("needs nothing when the run never uploaded", () => {
    expect(supplierCartCleanupFromPayload({ providerMutationPossible: false })).toMatchObject({
      status: "not_needed", manualRemovalRequired: false,
    });
  });

  it.each([{}, { providerInteractionAttempted: true }])(
    "warns when the payload does not rule out provider interaction: %j", (payload) => {
      const log = vi.fn();
      const record = reportSupplierCartCleanup({ vendor: "sendcutsend", quantity: 1, payload }, log);
      expect(record).toMatchObject({ status: "unknown", manualRemovalRequired: true });
      const [line, warn] = log.mock.calls[0]!;
      expect(warn).toBe(true);
      expect(JSON.parse(line)).toMatchObject({ level: "warn", action: expect.stringContaining("manually") });
    },
  );

  it("still warns when an adapter declares a possible mutation alongside a no-interaction claim", () => {
    const payload = { providerMutationPossible: true, providerInteractionAttempted: false };
    expect(supplierCartCleanupFromPayload(payload)).toMatchObject({ status: "not_declared", manualRemovalRequired: true });
  });

  it.each([null, undefined, {}, { providerMutationPossible: null }, { providerMutationPossible: "false" }])(
    "requires manual review when mutation evidence is missing or invalid: %j", (payload) => {
      expect(supplierCartCleanupFromPayload(payload)).toMatchObject({
        status: "unknown", manualRemovalRequired: true,
      });
    },
  );

  it.each(["xometry", "fictiv"])("warns for %s upload results without mutation evidence", (vendor) => {
    const log = vi.fn();
    const record = reportSupplierCartCleanup({
      vendor, quantity: 1, payload: { uploadSelector: "input[type=file]", offers: [] },
    }, log);
    expect(record).toMatchObject({ status: "unknown", manualRemovalRequired: true });
    const [line, warn] = log.mock.calls[0]!;
    expect(warn).toBe(true);
    expect(JSON.parse(line)).toMatchObject({ vendor, level: "warn", action: expect.stringContaining("Review") });
  });

  it("ignores an unknown cleanup status rather than trusting it", () => {
    expect(supplierCartCleanupFromPayload({ providerMutationPossible: true, cartCleanup: { status: "gone" } }))
      .toMatchObject({ status: "not_declared", manualRemovalRequired: true });
  });

  it("never throws when logging fails", () => {
    const record = reportSupplierCartCleanup(
      { vendor: "oshcut", quantity: 1, payload: { cartCleanup: { status: "removed", removed: 1, remaining: 0 } } },
      () => { throw new Error("stdout closed"); },
    );
    expect(record.status).toBe("removed");
  });
});
