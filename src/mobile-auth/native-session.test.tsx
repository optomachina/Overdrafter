import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  signOut: vi.fn(),
  onAuthStateChange: vi.fn(),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      signOut: authMocks.signOut,
      onAuthStateChange: authMocks.onAuthStateChange,
    },
  },
}));

import {
  NativeSessionRoute,
  NativeSessionSignOutObserver,
} from "./native-session";
import {
  reportNativeSessionStatus,
  runNativeSessionAction,
  type NativeSessionStatus,
} from "./native-session-control";

type AuthStateChangeCallback = (event: string) => void;

function installNativeHandler(postMessage = vi.fn()) {
  Object.defineProperty(window, "webkit", {
    configurable: true,
    value: {
      messageHandlers: {
        mobileAuth: {
          postMessage,
        },
      },
    },
  });

  return postMessage;
}

describe("native session control", () => {
  beforeEach(() => {
    authMocks.signOut.mockResolvedValue({ error: null });
    authMocks.onAuthStateChange.mockReturnValue({
      data: {
        subscription: {
          unsubscribe: vi.fn(),
        },
      },
    });
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "webkit");
  });

  it("reports an authenticated probe without credentials", async () => {
    const reportStatus = vi.fn();

    const status = await runNativeSessionAction("probe", {
      readAppSession: vi.fn().mockResolvedValue({
        authState: "authenticated",
        isVerifiedAuth: true,
        memberships: [],
        user: {
          id: "user-1",
          access_token: "must-not-leak",
        },
      }),
      clearPersistedSession: vi.fn(),
      reportStatus,
    });

    expect(status).toEqual({
      version: 1,
      status: "authenticated",
    });
    expect(JSON.stringify(reportStatus.mock.calls)).not.toContain("must-not-leak");
  });

  it.each(["anonymous", "invalid_session"] as const)(
    "reports %s probes as signed out and clears stale storage",
    async (authState) => {
      const clearPersistedSession = vi.fn();

      const status = await runNativeSessionAction("probe", {
        readAppSession: vi.fn().mockResolvedValue({
          authState,
          isVerifiedAuth: false,
          memberships: [],
          user: null,
        }),
        clearPersistedSession,
        reportStatus: vi.fn(),
      });

      expect(status).toEqual({
        version: 1,
        status: "signed_out",
      });
      expect(clearPersistedSession).toHaveBeenCalledOnce();
    },
  );

  it("reports a fixed network error without clearing a potentially valid session", async () => {
    const reportStatus = vi.fn();
    const clearPersistedSession = vi.fn();

    const status = await runNativeSessionAction("probe", {
      readAppSession: vi.fn().mockRejectedValue(new Error("raw service failure")),
      clearPersistedSession,
      reportStatus,
    });

    expect(status).toEqual({
      version: 1,
      status: "error",
      code: "mobile_auth_network_failed",
    });
    expect(JSON.stringify(reportStatus.mock.calls)).not.toContain("raw service failure");
    expect(clearPersistedSession).not.toHaveBeenCalled();
  });

  it("preserves persisted storage when a live probe cannot verify the session", async () => {
    const clearPersistedSession = vi.fn();

    const status = await runNativeSessionAction("probe", {
      readAppSession: vi.fn().mockResolvedValue({
        authState: "session_error",
        isVerifiedAuth: false,
        memberships: [],
        user: null,
      }),
      clearPersistedSession,
      reportStatus: vi.fn(),
    });

    expect(status).toEqual({
      version: 1,
      status: "error",
      code: "mobile_auth_network_failed",
    });
    expect(clearPersistedSession).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "unverified identity",
      session: {
        authState: "authenticated" as const,
        isVerifiedAuth: false,
        memberships: [],
        user: { id: "user-1" },
      },
    },
    {
      name: "membership resolution failure",
      session: {
        authState: "authenticated" as const,
        isVerifiedAuth: true,
        memberships: [],
        membershipError: "temporary failure",
        user: { id: "user-1" },
      },
    },
  ])("does not open native workspaces for a $name", async ({ session }) => {
    const clearPersistedSession = vi.fn();

    const status = await runNativeSessionAction("probe", {
      readAppSession: vi.fn().mockResolvedValue(session),
      clearPersistedSession,
      reportStatus: vi.fn(),
    });

    expect(status).toEqual({
      version: 1,
      status: "error",
      code: "mobile_auth_network_failed",
    });
    expect(clearPersistedSession).not.toHaveBeenCalled();
  });

  it("uses local Supabase logout, clears storage, and reports signed out", async () => {
    const clearPersistedSession = vi.fn();
    const reportStatus = vi.fn();

    const status = await runNativeSessionAction("logout", {
      client: {
        auth: {
          signOut: authMocks.signOut,
        },
      },
      clearPersistedSession,
      reportStatus,
    });

    expect(authMocks.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(clearPersistedSession).toHaveBeenCalledOnce();
    expect(status).toEqual({
      version: 1,
      status: "signed_out",
    });
    expect(reportStatus).toHaveBeenCalledWith(status);
  });

  it.each([
    {
      name: "returned error",
      signOut: vi.fn().mockResolvedValue({ error: new Error("secret failure") }),
    },
    {
      name: "thrown error",
      signOut: vi.fn().mockRejectedValue(new Error("secret failure")),
    },
  ])("clears storage and redacts a $name during logout", async ({ signOut }) => {
    const clearPersistedSession = vi.fn();
    const reportStatus = vi.fn();

    const status = await runNativeSessionAction("logout", {
      client: {
        auth: {
          signOut,
        },
      },
      clearPersistedSession,
      reportStatus,
    });

    expect(clearPersistedSession).toHaveBeenCalledOnce();
    expect(status).toEqual({
      version: 1,
      status: "error",
      code: "mobile_auth_logout_failed",
    });
    expect(JSON.stringify(reportStatus.mock.calls)).not.toContain("secret failure");
  });

  it("posts only through the fixed native message handler", () => {
    const postMessage = installNativeHandler();
    const status: NativeSessionStatus = {
      version: 1,
      status: "signed_out",
    };

    expect(reportNativeSessionStatus(status)).toBe(true);
    expect(postMessage).toHaveBeenCalledWith(status);
  });

  it("rejects unsupported control actions with a fixed error", async () => {
    const postMessage = installNativeHandler();
    window.history.replaceState(
      {},
      "",
      "/auth/mobile/native-session?app=ios&action=unknown",
    );

    render(<NativeSessionRoute />);

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        version: 1,
        status: "error",
        code: "mobile_auth_session_invalid",
      });
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Unable to complete the session request.",
    );
  });

  it("notifies iOS when an ordinary workspace route signs out", () => {
    const postMessage = installNativeHandler();
    let authCallback: AuthStateChangeCallback | null = null;
    const unsubscribe = vi.fn();
    authMocks.onAuthStateChange.mockImplementation(
      (callback: AuthStateChangeCallback) => {
        authCallback = callback;
        return {
          data: {
            subscription: {
              unsubscribe,
            },
          },
        };
      },
    );
    window.history.replaceState({}, "", "/parts?app=ios");

    const { unmount } = render(<NativeSessionSignOutObserver />);

    act(() => {
      authCallback?.("SIGNED_OUT");
    });

    expect(postMessage).toHaveBeenCalledWith({
      version: 1,
      status: "signed_out",
    });

    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
