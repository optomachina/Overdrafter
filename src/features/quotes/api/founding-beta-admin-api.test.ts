import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchFoundingBetaEnrollment,
  setFoundingBetaEnrollment,
} from "./founding-beta-admin-api";

const { callRpcMock } = vi.hoisted(() => ({ callRpcMock: vi.fn() }));

vi.mock("./shared/rpc", () => ({ callRpc: callRpcMock }));

const organizationId = "abcdef12-3456-4890-abcd-ef1234567890";
const enrollment = {
  organizationId,
  enrolled: true,
  latestAction: "grant",
  latestEventId: 12,
  latestEventAt: "2026-08-16T12:00:00.000Z",
  policyRevision: "founding-beta-2026-08-15",
  termsPath: "/legal/beta-terms",
  privacyPath: "/legal/privacy",
};

describe("founding-beta-admin-api", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads and validates the authoritative enrollment state", async () => {
    callRpcMock.mockResolvedValue({ data: enrollment, error: null });

    await expect(fetchFoundingBetaEnrollment(organizationId)).resolves.toEqual(
      enrollment,
    );
    expect(callRpcMock).toHaveBeenCalledWith(
      "api_admin_get_founding_beta_enrollment",
      { p_organization_id: organizationId },
    );
  });

  it.each([
    ["non-object", "invalid"],
    ["wrong organization", { ...enrollment, organizationId: crypto.randomUUID() }],
    ["invalid action", { ...enrollment, latestAction: "enable" }],
    ["inconsistent empty event", { ...enrollment, latestEventId: null }],
    ["inconsistent enrollment", { ...enrollment, enrolled: false }],
    ["invalid timestamp", { ...enrollment, latestEventAt: "not-a-date" }],
    ["non-boolean enrollment", { ...enrollment, enrolled: "true" }],
  ])("fails closed for a %s enrollment response", async (_label, data) => {
    callRpcMock.mockResolvedValue({ data, error: null });

    await expect(fetchFoundingBetaEnrollment(organizationId)).rejects.toThrow(
      TypeError,
    );
  });

  it("submits an audited enrollment mutation with the exact intent", async () => {
    callRpcMock.mockResolvedValue({
      data: { eventId: 13, replayed: false, organizationId, enrolled: false },
      error: null,
    });

    await expect(
      setFoundingBetaEnrollment({
        organizationId,
        enrolled: false,
        reason: "Validation window ended",
        idempotencyKey: "intent-1",
      }),
    ).resolves.toEqual({
      eventId: 13,
      replayed: false,
      organizationId,
      enrolled: false,
    });
    expect(callRpcMock).toHaveBeenCalledWith(
      "api_admin_set_founding_beta_enrollment",
      {
        p_organization_id: organizationId,
        p_enrolled: false,
        p_reason: "Validation window ended",
        p_idempotency_key: "intent-1",
      },
    );
  });

  it("fails closed when the mutation response differs from the request", async () => {
    callRpcMock.mockResolvedValue({
      data: { eventId: 13, replayed: false, organizationId, enrolled: true },
      error: null,
    });

    await expect(
      setFoundingBetaEnrollment({
        organizationId,
        enrolled: false,
        reason: "Validation window ended",
        idempotencyKey: "intent-1",
      }),
    ).rejects.toThrow(TypeError);
  });

  it("propagates server denials without accepting partial data", async () => {
    const error = { message: "Multi-factor authentication is required." };
    callRpcMock.mockResolvedValue({ data: enrollment, error });

    await expect(fetchFoundingBetaEnrollment(organizationId)).rejects.toBe(error);
  });
});
