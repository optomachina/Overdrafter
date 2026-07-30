import type { Session } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOOTSTRAP_CONFIG_ELEMENT_ID,
  reportBootstrapStatus,
  runBootstrapEntry,
  type BootstrapConfig,
  type BootstrapStatus,
} from "./bootstrap";

const STATE = "A".repeat(43);
const ACCESS_TOKEN = "bootstrap-access-token";
const REFRESH_TOKEN = "bootstrap-refresh-token";

type TestBootstrapClient = NonNullable<
  NonNullable<Parameters<typeof runBootstrapEntry>[0]>["client"]
>;

function createSession(): Session {
  return {
    access_token: ACCESS_TOKEN,
    refresh_token: REFRESH_TOKEN,
    token_type: "bearer",
    expires_in: 3_600,
    expires_at: 4_102_444_800,
    user: {
      id: "user-id",
      app_metadata: {},
      user_metadata: {},
      aud: "authenticated",
      created_at: "2026-01-01T00:00:00.000Z",
    },
  };
}

function createClient(
  setSessionResult: {
    data: { session: Session | null };
    error: unknown | null;
  } = {
    data: { session: createSession() },
    error: null,
  },
): TestBootstrapClient {
  return {
    auth: {
      setSession: vi.fn().mockResolvedValue(setSessionResult),
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: "user-id" } },
        error: null,
      }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
    },
  };
}

function mountConfig(config: unknown) {
  const element = document.createElement("script");
  element.id = BOOTSTRAP_CONFIG_ELEMENT_ID;
  element.type = "application/json";
  element.textContent = JSON.stringify(config);
  document.body.append(element);
}

function successConfig(): BootstrapConfig & { status: "ready" } {
  return {
    version: 1,
    status: "ready",
    state: STATE,
    returnTo: "/quotes",
    session: {
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
    },
  };
}

describe("mobile authentication bootstrap", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    window.localStorage.clear();
    Reflect.deleteProperty(window, "webkit");
    vi.restoreAllMocks();
  });

  it("does nothing when inert bootstrap configuration is absent", async () => {
    const client = createClient();
    const reportStatus = vi.fn();
    const clearPersistedSession = vi.fn();

    await expect(
      runBootstrapEntry({
        document,
        client,
        reportStatus,
        clearPersistedSession,
      }),
    ).resolves.toBeNull();

    expect(client.auth.setSession).not.toHaveBeenCalled();
    expect(client.auth.signOut).not.toHaveBeenCalled();
    expect(reportStatus).not.toHaveBeenCalled();
    expect(clearPersistedSession).not.toHaveBeenCalled();
  });

  it("persists the transferred session and reports only ready state metadata", async () => {
    const client = createClient();
    const statuses: BootstrapStatus[] = [];
    const clearPersistedSession = vi.fn();
    const hasNativeHost = vi.fn(() => true);
    mountConfig(successConfig());

    const result = await runBootstrapEntry({
      document,
      client,
      hasNativeHost,
      reportStatus(status) {
        statuses.push(status);
      },
      clearPersistedSession,
    });

    expect(client.auth.setSession).toHaveBeenCalledTimes(1);
    expect(client.auth.setSession).toHaveBeenCalledWith({
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
    });
    expect(client.auth.getUser).toHaveBeenCalledTimes(1);
    expect(client.auth.signOut).not.toHaveBeenCalled();
    expect(clearPersistedSession).not.toHaveBeenCalled();
    expect(hasNativeHost.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(client.auth.setSession).mock.invocationCallOrder[0],
    );
    expect(document.getElementById(BOOTSTRAP_CONFIG_ELEMENT_ID)).toBeNull();
    expect(result).toEqual({
      version: 1,
      status: "ready",
      state: STATE,
      returnTo: "/quotes",
    });
    expect(statuses).toEqual([result]);

    const serializedStatus = JSON.stringify(statuses);
    expect(serializedStatus).not.toContain(ACCESS_TOKEN);
    expect(serializedStatus).not.toContain(REFRESH_TOKEN);
    expect(serializedStatus).not.toContain("user-id");
  });

  it("does not accept transferred credentials in a regular browser without the native handler", async () => {
    const client = createClient();
    const reportStatus = vi.fn();
    const clearPersistedSession = vi.fn();
    mountConfig(successConfig());

    await expect(
      runBootstrapEntry({
        document,
        client,
        reportStatus,
        clearPersistedSession,
      }),
    ).resolves.toBeNull();

    expect(client.auth.setSession).not.toHaveBeenCalled();
    expect(client.auth.getUser).not.toHaveBeenCalled();
    expect(client.auth.signOut).not.toHaveBeenCalled();
    expect(reportStatus).not.toHaveBeenCalled();
    expect(clearPersistedSession).not.toHaveBeenCalled();
    expect(document.getElementById(BOOTSTRAP_CONFIG_ELEMENT_ID)).toBeNull();
  });

  it("rejects a server payload whose return route exceeds the shared allowlist", async () => {
    const client = createClient();
    const reportStatus = vi.fn();
    const clearPersistedSession = vi.fn();
    mountConfig({
      ...successConfig(),
      returnTo: `/parts/${"a".repeat(129)}`,
    });

    await expect(
      runBootstrapEntry({
        document,
        client,
        reportStatus,
        clearPersistedSession,
        hasNativeHost: () => true,
      }),
    ).resolves.toBeNull();

    expect(client.auth.setSession).not.toHaveBeenCalled();
    expect(reportStatus).not.toHaveBeenCalled();
    expect(clearPersistedSession).not.toHaveBeenCalled();
  });

  it("clears partial auth state and redacts errors when session persistence fails", async () => {
    const client = createClient({
      data: { session: null },
      error: new Error(`failed for ${ACCESS_TOKEN}`),
    });
    client.auth.signOut = vi
      .fn()
      .mockRejectedValue(new Error(`sign out failed for ${REFRESH_TOKEN}`));
    const reportStatus = vi.fn();
    const clearPersistedSession = vi.fn();
    mountConfig(successConfig());

    const result = await runBootstrapEntry({
      document,
      client,
      hasNativeHost: () => true,
      reportStatus,
      clearPersistedSession,
    });

    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(clearPersistedSession).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      version: 1,
      status: "error",
      state: STATE,
      code: "mobile_auth_bootstrap_failed",
      retry: "restart",
    });
    expect(reportStatus).toHaveBeenCalledWith(result);
    expect(JSON.stringify(reportStatus.mock.calls)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(reportStatus.mock.calls)).not.toContain(REFRESH_TOKEN);
  });

  it("clears the persisted session when server-backed user verification disagrees", async () => {
    const client = createClient();
    client.auth.getUser = vi.fn().mockResolvedValue({
      data: { user: { id: "different-user-id" } },
      error: null,
    });
    const reportStatus = vi.fn();
    const clearPersistedSession = vi.fn();
    mountConfig(successConfig());

    const result = await runBootstrapEntry({
      document,
      client,
      hasNativeHost: () => true,
      reportStatus,
      clearPersistedSession,
    });

    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(clearPersistedSession).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      version: 1,
      status: "error",
      state: STATE,
      code: "mobile_auth_bootstrap_failed",
      retry: "restart",
    });
    expect(reportStatus).toHaveBeenCalledWith(result);
  });

  it("passes through allowlisted server failures without replacing the existing session", async () => {
    const client = createClient();
    const reportStatus = vi.fn();
    const clearPersistedSession = vi.fn();
    mountConfig({
      version: 1,
      state: STATE,
      error: {
        code: "mobile_auth_expired",
        retry: "restart",
      },
    });

    const result = await runBootstrapEntry({
      document,
      client,
      hasNativeHost: () => true,
      reportStatus,
      clearPersistedSession,
    });

    expect(client.auth.setSession).not.toHaveBeenCalled();
    expect(client.auth.getUser).not.toHaveBeenCalled();
    expect(client.auth.signOut).not.toHaveBeenCalled();
    expect(clearPersistedSession).not.toHaveBeenCalled();
    expect(result).toEqual({
      version: 1,
      status: "error",
      state: STATE,
      code: "mobile_auth_expired",
      retry: "restart",
    });
    expect(reportStatus).toHaveBeenCalledWith(result);
  });

  it("posts through only the fixed WK mobileAuth handler", () => {
    const received: BootstrapStatus[] = [];
    const status: BootstrapStatus = {
      version: 1,
      status: "ready",
      state: STATE,
      returnTo: "/quotes",
    };

    Object.defineProperty(window, "webkit", {
      configurable: true,
      value: {
        messageHandlers: {
          mobileAuth: {
            postMessage(message: BootstrapStatus) {
              received.push(message);
            },
          },
          arbitrary: {
            postMessage: vi.fn(),
          },
        },
      },
    });

    expect(reportBootstrapStatus(status)).toBe(true);
    expect(received).toEqual([status]);
    expect(Object.keys(received[0]).sort()).toEqual(["returnTo", "state", "status", "version"]);
  });
});
