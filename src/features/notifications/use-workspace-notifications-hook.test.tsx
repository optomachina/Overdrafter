import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceNotifications } from "./use-workspace-notifications";

const { fetchClientActivityEventsByJobIdsMock, fetchPlatformAdminNotificationsMock } = vi.hoisted(() => ({
  fetchClientActivityEventsByJobIdsMock: vi.fn(),
  fetchPlatformAdminNotificationsMock: vi.fn(),
}));

vi.mock("@/features/quotes/api/workspace-access", () => ({
  fetchClientActivityEventsByJobIds: fetchClientActivityEventsByJobIdsMock,
  fetchPlatformAdminNotifications: fetchPlatformAdminNotificationsMock,
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

const providerRecord = {
  id: "provider.integration_added:quickparts:manifest-v1",
  eventType: "provider.integration_added" as const,
  providerKey: "quickparts",
  policyRevision: "manifest-v1",
  admissionState: "disabled" as const,
  genericDispatchEnabled: false as const,
  occurredAt: "2026-09-05T03:30:00.000Z",
};

describe("useWorkspaceNotifications platform-admin feed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    fetchClientActivityEventsByJobIdsMock.mockResolvedValue([]);
    fetchPlatformAdminNotificationsMock.mockResolvedValue([providerRecord]);
  });

  it("loads, projects, and locally marks provider notifications seen for a platform admin", async () => {
    const { result } = renderHook(
      () =>
        useWorkspaceNotifications({
          accessScope: "platform-admin-scope",
          isPlatformAdmin: true,
          jobIds: [],
          role: "internal_admin",
          userId: "admin-user",
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.items).toHaveLength(1);
    });
    expect(fetchPlatformAdminNotificationsMock).toHaveBeenCalledWith(20);
    expect(fetchClientActivityEventsByJobIdsMock).not.toHaveBeenCalled();
    expect(result.current.items[0]).toEqual(
      expect.objectContaining({
        notificationType: "platform.provider_added",
        isSeen: false,
      }),
    );

    act(() => {
      result.current.setItemSeen(result.current.items[0].id, true);
    });

    expect(result.current.items[0].isSeen).toBe(true);
  });

  it("does not query or expose the platform feed without platform-admin authority", async () => {
    const { result } = renderHook(
      () =>
        useWorkspaceNotifications({
          accessScope: "internal-scope",
          isPlatformAdmin: false,
          jobIds: [],
          role: "internal_admin",
          userId: "internal-user",
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(fetchPlatformAdminNotificationsMock).not.toHaveBeenCalled();
    expect(result.current.supportedTypes).not.toContain("platform.provider_added");
    expect(result.current.items).toEqual([]);
  });

  it("surfaces a truthful feed error instead of reporting an empty inbox", async () => {
    fetchPlatformAdminNotificationsMock.mockRejectedValue(new Error("network unavailable"));

    const { result } = renderHook(
      () =>
        useWorkspaceNotifications({
          accessScope: "platform-admin-scope",
          isPlatformAdmin: true,
          jobIds: [],
          role: "internal_admin",
          userId: "admin-user",
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.errorMessage).toBe("Some notifications could not be loaded. Refresh and try again.");
    });
  });
});
