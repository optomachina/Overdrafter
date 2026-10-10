// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { runCapabilityCanaryTool } from "./providerCapabilityCanary.js";

describe("capability canary executable gate", () => {
  it.each([{}, { CANARY_SCHEDULE_ENABLED: "true" }, { CANARY_TRIGGER_ENABLED: "true" },
    { CANARY_SCHEDULE_ENABLED: "TRUE", CANARY_TRIGGER_ENABLED: "true" }])("defaults off before request parsing or execution: %j", async (env) => {
    const execute = vi.fn();
    expect(await runCapabilityCanaryTool({ ...env, CANARY_REQUEST_JSON: "private invalid json" }, [], execute)).toEqual({ state: "disabled" });
    expect(execute).not.toHaveBeenCalled();
  });
  it("rejects malformed and excessive requests and arbitrary arguments", async () => {
    const execute = vi.fn(); const env = { CANARY_SCHEDULE_ENABLED: "true", CANARY_TRIGGER_ENABLED: "true", CANARY_REQUEST_JSON: "{" };
    expect(await runCapabilityCanaryTool(env, [], execute)).toEqual({ state: "invalid_configuration" });
    expect(await runCapabilityCanaryTool({ ...env, CANARY_REQUEST_JSON: "x".repeat(65537) }, [], execute)).toEqual({ state: "invalid_configuration" });
    expect(await runCapabilityCanaryTool({ ...env, CANARY_REQUEST_JSON: "{}" }, ["--module", "unsafe"], execute)).toEqual({ state: "invalid_configuration" });
    expect(execute).not.toHaveBeenCalled();
  });
  it("truthfully blocks enabled execution without a reviewed installed probe", async () => {
    const request = { plan: {}, windowIndex: 0,
      scheduleAuthorization: { enabled: true, evidenceReference: "issue:OVD-415", planDigest: "unused", expiresAt: "2099-01-01T00:00:00.000Z" },
      triggerAuthorization: { enabled: true, evidenceReference: "issue:OVD-415", windowKey: "unused", expiresAt: "2099-01-01T00:00:00.000Z" } };
    expect(await runCapabilityCanaryTool({ CANARY_SCHEDULE_ENABLED: "true", CANARY_TRIGGER_ENABLED: "true", CANARY_REQUEST_JSON: JSON.stringify(request) }, []))
      .toEqual({ state: "reviewed_probe_unavailable" });
  });
});
