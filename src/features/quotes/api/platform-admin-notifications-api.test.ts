import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPlatformAdminNotifications } from "./platform-admin-api";

const { callRpcMock, callUntypedRpcMock } = vi.hoisted(() => ({
  callRpcMock: vi.fn(),
  callUntypedRpcMock: vi.fn(),
}));

vi.mock("./shared/rpc", () => ({
  callRpc: callRpcMock,
  callUntypedRpc: callUntypedRpcMock,
}));

describe("fetchPlatformAdminNotifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the minimal provider-added feed", async () => {
    const rows = [
      {
        id: "provider.integration_added:quickparts:manifest-v1",
        eventType: "provider.integration_added",
        providerKey: "quickparts",
        policyRevision: "manifest-v1",
        admissionState: "disabled",
        genericDispatchEnabled: false,
        occurredAt: "2026-09-05T03:30:00.000Z",
      },
    ];
    callUntypedRpcMock.mockResolvedValue({ data: rows, error: null });

    await expect(fetchPlatformAdminNotifications(12)).resolves.toEqual(rows);
    expect(callUntypedRpcMock).toHaveBeenCalledWith(
      "api_admin_list_platform_notifications",
      { p_limit: 12 },
    );
  });

  it("returns an empty feed while the migration is not deployed", async () => {
    callUntypedRpcMock.mockResolvedValue({
      data: null,
      error: {
        code: "PGRST202",
        message: "Could not find the function public.api_admin_list_platform_notifications in the schema cache",
      },
    });

    await expect(fetchPlatformAdminNotifications()).resolves.toEqual([]);
  });

  it("propagates non-compatibility RPC failures", async () => {
    const error = { code: "42501", message: "Platform admin access required." };
    callUntypedRpcMock.mockResolvedValue({ data: null, error });

    await expect(fetchPlatformAdminNotifications()).rejects.toEqual(error);
  });

  it("fails closed on malformed response records", async () => {
    callUntypedRpcMock.mockResolvedValue({
      data: [{ eventType: "provider.integration_added", genericDispatchEnabled: true }],
      error: null,
    });

    await expect(fetchPlatformAdminNotifications()).rejects.toThrow(TypeError);
  });

  it("fails closed on invalid timestamps", async () => {
    callUntypedRpcMock.mockResolvedValue({
      data: [
        {
          id: "provider.integration_added:quickparts:manifest-v1",
          eventType: "provider.integration_added",
          providerKey: "quickparts",
          policyRevision: "manifest-v1",
          admissionState: "disabled",
          genericDispatchEnabled: false,
          occurredAt: "not-a-timestamp",
        },
      ],
      error: null,
    });

    await expect(fetchPlatformAdminNotifications()).rejects.toThrow(TypeError);
  });
});
