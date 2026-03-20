import "@testing-library/jest-dom/vitest";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppMembership } from "@/features/quotes/types";
import { WorkspaceNotReadyError } from "@/lib/workspace-errors";
import { useWorkspaceReadiness } from "./use-workspace-readiness";
import {
  MISSING_WORKSPACE_MEMBERSHIP_ERROR_MESSAGE,
  type WorkspaceReadinessInput,
} from "./workspace-readiness";

const mockUser = { id: "user-1", email: "user@example.com" } as WorkspaceReadinessInput["user"];

const mockMembership: AppMembership = {
  id: "mem-1",
  role: "client",
  organizationId: "org-1",
  organizationName: "Test Org",
  organizationSlug: "test-org",
};

function base(overrides: Partial<WorkspaceReadinessInput> = {}): WorkspaceReadinessInput {
  return {
    user: mockUser,
    isLoading: false,
    isVerifiedAuth: true,
    activeMembership: mockMembership,
    membershipCount: 1,
    bootstrapStatus: "idle",
    bootstrapErrorMessage: null,
    membershipResolutionStatus: "idle",
    membershipResolutionErrorMessage: null,
    membershipResolutionAttempt: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useWorkspaceReadiness", () => {
  it("resolves waitForReady immediately when workspace is ready", async () => {
    const { result } = renderHook(() => useWorkspaceReadiness(base()));

    const membership = await result.current.waitForReady();
    expect(membership).toEqual(mockMembership);
  });

  it("rejects waitForReady immediately when anonymous", async () => {
    const { result } = renderHook(() => useWorkspaceReadiness(base({ user: null, membershipCount: 0 })));

    await expect(result.current.waitForReady()).rejects.toBeInstanceOf(WorkspaceNotReadyError);
  });

  it("rejects waitForReady immediately when unverified", async () => {
    const { result } = renderHook(() =>
      useWorkspaceReadiness(base({ isVerifiedAuth: false, activeMembership: null, membershipCount: 0 })),
    );

    await expect(result.current.waitForReady()).rejects.toBeInstanceOf(WorkspaceNotReadyError);
  });

  it("rejects waitForReady immediately when provisioning_failed", async () => {
    const { result } = renderHook(() =>
      useWorkspaceReadiness(
        base({
          activeMembership: null,
          membershipCount: 0,
          bootstrapStatus: "error",
          bootstrapErrorMessage: "Internal server error",
        }),
      ),
    );

    await expect(result.current.waitForReady()).rejects.toBeInstanceOf(WorkspaceNotReadyError);
  });

  it("waits then resolves when workspace transitions from provisioning to ready", async () => {
    let input = base({
      activeMembership: null,
      membershipCount: 0,
      bootstrapStatus: "success",
      membershipResolutionStatus: "retrying",
      membershipResolutionAttempt: 1,
    });
    const { result, rerender } = renderHook(() => useWorkspaceReadiness(input));

    let resolvedMembership: AppMembership | undefined;
    const waitPromise = result.current.waitForReady().then((m) => {
      resolvedMembership = m;
    });

    // Still provisioning — should not have resolved yet
    expect(resolvedMembership).toBeUndefined();

    // Transition to ready
    input = base({ activeMembership: mockMembership, membershipCount: 1 });
    act(() => {
      rerender();
    });

    await waitPromise;
    expect(resolvedMembership).toEqual(mockMembership);
  });

  it("rejects after 30s timeout while provisioning", async () => {
    const input = base({ activeMembership: null, membershipCount: 0, bootstrapStatus: "pending" });
    const { result } = renderHook(() => useWorkspaceReadiness(input));

    let rejected: Error | undefined;
    const waitPromise = result.current.waitForReady().catch((e: Error) => {
      rejected = e;
    });

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    await waitPromise;
    expect(rejected).toBeInstanceOf(WorkspaceNotReadyError);
  });

  it("exposes readiness status", () => {
    const { result } = renderHook(() => useWorkspaceReadiness(base()));
    expect(result.current.readiness.status).toBe("ready");
  });

  it("rejects immediately when membership recovery is exhausted", async () => {
    const { result } = renderHook(() =>
      useWorkspaceReadiness(
        base({
          activeMembership: null,
          membershipCount: 0,
          bootstrapStatus: "success",
          membershipResolutionStatus: "exhausted",
          membershipResolutionErrorMessage: MISSING_WORKSPACE_MEMBERSHIP_ERROR_MESSAGE,
        }),
      ),
    );

    await expect(result.current.waitForReady()).rejects.toMatchObject({
      message: MISSING_WORKSPACE_MEMBERSHIP_ERROR_MESSAGE,
    });
  });

  it("does not wait for the 30s timeout once membership recovery is exhausted", async () => {
    const { result } = renderHook(() =>
      useWorkspaceReadiness(
        base({
          activeMembership: null,
          membershipCount: 0,
          bootstrapStatus: "error",
          bootstrapErrorMessage: "User already has an organization membership",
          membershipResolutionStatus: "exhausted",
          membershipResolutionErrorMessage: MISSING_WORKSPACE_MEMBERSHIP_ERROR_MESSAGE,
        }),
      ),
    );

    let rejected: Error | undefined;
    const waitPromise = result.current.waitForReady().catch((error: Error) => {
      rejected = error;
    });

    act(() => {
      vi.advanceTimersByTime(29_000);
    });

    await waitPromise;
    expect(rejected?.message).toBe(MISSING_WORKSPACE_MEMBERSHIP_ERROR_MESSAGE);
  });

  it("WorkspaceNotReadyError has expected toastId", async () => {
    const { result } = renderHook(() => useWorkspaceReadiness(base({ user: null })));

    const error = await result.current.waitForReady().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkspaceNotReadyError);
    expect((error as WorkspaceNotReadyError).toastId).toBe("upload-workspace-gate");
  });
});
