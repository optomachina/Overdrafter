import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useClientWorkspaceNotifications } from "./use-client-workspace-notifications";

const { useWorkspaceNotificationsMock, notificationCenter } = vi.hoisted(() => ({
  useWorkspaceNotificationsMock: vi.fn(),
  notificationCenter: { unseenCount: 2 },
}));

vi.mock("./use-workspace-notifications", () => ({
  useWorkspaceNotifications: useWorkspaceNotificationsMock,
}));

describe("useClientWorkspaceNotifications", () => {
  beforeEach(() => {
    useWorkspaceNotificationsMock.mockReset().mockReturnValue(notificationCenter);
  });

  it("forwards current workspace context and job IDs and returns the notification center unchanged", () => {
    const controller = {
      workspaceAccessScope: "client-scope",
      isPlatformAdmin: false,
      activeMembership: { role: "client" as const },
      user: { id: "client-user" },
    };
    const jobIds = ["job-2", "job-1"];
    const { result, rerender } = renderHook(
      (props) => useClientWorkspaceNotifications(props.controller, props.jobIds),
      { initialProps: { controller, jobIds } },
    );

    expect(result.current).toBe(notificationCenter);
    expect(useWorkspaceNotificationsMock).toHaveBeenLastCalledWith({
      accessScope: "client-scope",
      isPlatformAdmin: false,
      jobIds,
      role: "client",
      userId: "client-user",
    });
    expect(useWorkspaceNotificationsMock.mock.lastCall?.[0].jobIds).toBe(jobIds);

    rerender({
      controller: { ...controller, workspaceAccessScope: "admin-scope", isPlatformAdmin: true, user: { id: "admin-user" } },
      jobIds: ["job-3"],
    });

    expect(useWorkspaceNotificationsMock).toHaveBeenLastCalledWith({
      accessScope: "admin-scope",
      isPlatformAdmin: true,
      jobIds: ["job-3"],
      role: "client",
      userId: "admin-user",
    });
  });

  it.each([null, undefined])("handles %s user and membership without supplying an identity or role", (missing) => {
    renderHook(() => useClientWorkspaceNotifications({
      workspaceAccessScope: "anonymous-scope",
      isPlatformAdmin: false,
      activeMembership: missing,
      user: missing,
    }, []));

    expect(useWorkspaceNotificationsMock).toHaveBeenLastCalledWith({
      accessScope: "anonymous-scope",
      isPlatformAdmin: false,
      jobIds: [],
      role: undefined,
      userId: undefined,
    });
  });
});
