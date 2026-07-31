import type { Session } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CEREMONY_CONFIG_ELEMENT_ID,
  createCeremonyController,
  createNamespacedSessionStorage,
  readCeremonyConfig,
  runCeremonyEntry,
  type CeremonyAuthClient,
  type CeremonyClientFactory,
  type CeremonyClientOptions,
  type CeremonyConfig,
} from "./ceremony";

const TEST_STATE = "overdrafter.mobile-auth.v1.transaction-123";
const TEST_CSRF = "c".repeat(43);
const TRANSACTION_ID = "018f4d67-89ab-7cde-8abc-0123456789ab";
const ACCESS_TOKEN = "access-token-value";
const REFRESH_TOKEN = "refresh-token-value";

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

function createConfig(): CeremonyConfig {
  return {
    version: 1,
    storageNamespace: TEST_STATE,
    csrf: TEST_CSRF,
    supabaseUrl: "https://example.supabase.co/",
    supabasePublishableKey: "publishable-key",
    providerCallbackUrl:
      `${window.location.origin}/auth/mobile/provider-callback?cb=${TRANSACTION_ID}`,
    completeUrl: `${window.location.origin}/auth/mobile/complete`,
  };
}

function ceremonyAuthStorageKey(config: CeremonyConfig) {
  return `session:${config.storageNamespace}`;
}

function mountConfig(config: unknown) {
  const configElement = document.createElement("script");
  configElement.id = CEREMONY_CONFIG_ELEMENT_ID;
  configElement.type = "application/json";
  configElement.textContent = JSON.stringify(config);
  document.body.append(configElement);
}

function serializedSessionStorage() {
  const entries: string[] = [];

  for (let index = 0; index < window.sessionStorage.length; index += 1) {
    const key = window.sessionStorage.key(index);
    if (key) {
      entries.push(`${key}=${window.sessionStorage.getItem(key)}`);
    }
  }

  return entries.join("&");
}

function createAuthClient(overrides: Partial<CeremonyAuthClient["auth"]> = {}): CeremonyAuthClient {
  return {
    auth: {
      signInWithPassword: vi.fn().mockResolvedValue({
        data: { session: createSession() },
        error: null,
      }),
      signUp: vi.fn().mockResolvedValue({
        data: { session: null },
        error: null,
      }),
      signInWithOAuth: vi.fn().mockResolvedValue({
        data: { url: "https://example.supabase.co/authorize" },
        error: null,
      }),
      exchangeCodeForSession: vi.fn().mockResolvedValue({
        data: { session: createSession() },
        error: null,
      }),
      ...overrides,
    },
  };
}

describe("mobile authentication ceremony", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
  });

  it("isolates and clears only the selected transaction namespace", () => {
    const first = createNamespacedSessionStorage("first", window.sessionStorage);
    const second = createNamespacedSessionStorage("second", window.sessionStorage);
    const tokenPayload = JSON.stringify({
      access_token: ACCESS_TOKEN,
      refresh_token: REFRESH_TOKEN,
    });

    window.sessionStorage.setItem("unrelated", "keep");
    first.setItem("session-code-verifier", "first-verifier");
    second.setItem("session-code-verifier", "second-verifier");
    first.setItem("session", tokenPayload);
    second.setItem("session", "second-memory-session");

    expect(first.getItem("session-code-verifier")).toBe("first-verifier");
    expect(second.getItem("session-code-verifier")).toBe("second-verifier");
    expect(first.getItem("session")).toBe(tokenPayload);
    expect(second.getItem("session")).toBe("second-memory-session");
    expect(serializedSessionStorage()).not.toContain(ACCESS_TOKEN);
    expect(serializedSessionStorage()).not.toContain(REFRESH_TOKEN);

    const reloadedFirst = createNamespacedSessionStorage("first", window.sessionStorage);
    expect(reloadedFirst.getItem("session-code-verifier")).toBe("first-verifier");
    expect(reloadedFirst.getItem("session")).toBeNull();

    first.clear();

    expect(first.getItem("session-code-verifier")).toBeNull();
    expect(first.getItem("session")).toBeNull();
    expect(reloadedFirst.getItem("session-code-verifier")).toBeNull();
    expect(second.getItem("session-code-verifier")).toBe("second-verifier");
    expect(second.getItem("session")).toBe("second-memory-session");
    expect(window.sessionStorage.getItem("unrelated")).toBe("keep");
  });

  it("creates the dedicated client with scoped PKCE session storage", () => {
    const client = createAuthClient();
    let capturedOptions: CeremonyClientOptions | null = null;
    const clientFactory: CeremonyClientFactory = vi.fn((_url, _key, options) => {
      capturedOptions = options;
      return client;
    });

    createCeremonyController(createConfig(), {
      clientFactory,
      document,
      history: window.history,
      location: window.location,
      sessionStorage: window.sessionStorage,
    });

    expect(clientFactory).toHaveBeenCalledWith(
      "https://example.supabase.co/",
      "publishable-key",
      expect.any(Object),
    );
    expect(capturedOptions?.auth).toMatchObject({
      storageKey: `session:${TEST_STATE}`,
      persistSession: true,
      flowType: "pkce",
      detectSessionInUrl: false,
      autoRefreshToken: false,
    });

    const authStorageKey = capturedOptions?.auth.storageKey;
    expect(authStorageKey).toBe(`session:${TEST_STATE}`);
    capturedOptions?.auth.storage.setItem(`${authStorageKey}-code-verifier`, "verifier");
    capturedOptions?.auth.storage.setItem(
      String(authStorageKey),
      JSON.stringify({
        access_token: ACCESS_TOKEN,
        refresh_token: REFRESH_TOKEN,
      }),
    );

    expect(window.localStorage).toHaveLength(0);
    expect(window.sessionStorage).toHaveLength(1);
    expect(serializedSessionStorage()).toContain("verifier");
    expect(serializedSessionStorage()).not.toContain(ACCESS_TOKEN);
    expect(serializedSessionStorage()).not.toContain(REFRESH_TOKEN);

    const reloadedStorage = createNamespacedSessionStorage(TEST_STATE, window.sessionStorage);
    expect(reloadedStorage.getItem(`${authStorageKey}-code-verifier`)).toBe("verifier");
    expect(reloadedStorage.getItem(String(authStorageKey))).toBeNull();
  });

  it("accepts only an exact transaction-bound provider callback URL", () => {
    const validConfig = createConfig();
    mountConfig(validConfig);

    expect(readCeremonyConfig(document)).toEqual({
      ...validConfig,
      supabaseUrl: "https://example.supabase.co",
    });

    const origin = new URL(window.location.origin);
    const callbackPath = "/auth/mobile/provider-callback";
    const invalidProviderCallbackUrls = [
      `${window.location.origin}${callbackPath}`,
      `${window.location.origin}${callbackPath}?cb=${TRANSACTION_ID}&cb=${TRANSACTION_ID}`,
      `${window.location.origin}${callbackPath}?cb=${TRANSACTION_ID}&next=%2Fquotes`,
      `${window.location.origin}${callbackPath}?cb=${TRANSACTION_ID}#fragment`,
      `${origin.protocol}//user@${origin.host}${callbackPath}?cb=${TRANSACTION_ID}`,
      `${window.location.origin}${callbackPath}?cb=not-a-transaction`,
      `${window.location.origin}${callbackPath}?cb=%30${TRANSACTION_ID.slice(1)}`,
    ];

    for (const providerCallbackUrl of invalidProviderCallbackUrls) {
      mountConfig({
        ...validConfig,
        providerCallbackUrl,
      });
      expect(readCeremonyConfig(document)).toBeNull();
    }
  });

  it.each([
    "access_denied",
    "invalid_request",
    "server_error",
    "temporarily_unavailable",
  ] as const)("accepts the shared provider error %s in ceremony config", (error) => {
    const validConfig = createConfig();
    mountConfig({
      ...validConfig,
      mode: "error",
      error,
    });

    expect(readCeremonyConfig(document)).toEqual({
      ...validConfig,
      supabaseUrl: "https://example.supabase.co",
      callback: {
        mode: "error",
        error,
      },
    });
  });

  it("scrubs a provider code before one exchange and submits only completion fields", async () => {
    const events: string[] = [];
    const config = createConfig();
    const storage = createNamespacedSessionStorage(config.storageNamespace, window.sessionStorage);
    const authStorageKey = ceremonyAuthStorageKey(config);
    storage.setItem(`${authStorageKey}-code-verifier`, "verifier");
    window.sessionStorage.setItem("unrelated", "keep");
    window.history.replaceState(
      null,
      "",
      `/auth/mobile/provider-callback?cb=${TRANSACTION_ID}&code=provider-code`,
    );

    const originalReplaceState = window.history.replaceState.bind(window.history);
    const replaceState = vi.fn((data: unknown, unused: string, url?: string | URL | null) => {
      events.push("scrub");
      originalReplaceState(data, unused, url);
    });
    const exchangeCodeForSession = vi.fn(async () => {
      events.push("exchange");
      return {
        data: { session: createSession() },
        error: null,
      };
    });
    const submittedForms: Array<{
      action: string;
      method: string;
      target: string;
      enctype: string;
      fields: Record<string, string>;
    }> = [];

    const controller = createCeremonyController(config, {
      document,
      history: { replaceState },
      location: window.location,
      sessionStorage: window.sessionStorage,
      clientFactory: () => createAuthClient({ exchangeCodeForSession }),
      submitForm(form) {
        events.push("submit");
        submittedForms.push({
          action: form.action,
          method: form.method,
          target: form.target,
          enctype: form.enctype,
          fields: Object.fromEntries(new FormData(form).entries()) as Record<string, string>,
        });
      },
    });

    const first = controller.handleProviderCallback();
    const second = controller.handleProviderCallback();

    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ status: "submitted" });

    expect(exchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(exchangeCodeForSession).toHaveBeenCalledWith("provider-code");
    expect(events.indexOf("scrub")).toBeLessThan(events.indexOf("exchange"));
    expect(window.location.href).not.toContain("provider-code");
    expect(window.location.pathname).toBe("/auth/mobile/provider-callback");
    expect(submittedForms).toEqual([
      {
        action: `${window.location.origin}/auth/mobile/complete`,
        method: "post",
        target: "_self",
        enctype: "application/x-www-form-urlencoded",
        fields: {
          v: "1",
          csrf: TEST_CSRF,
          access_token: ACCESS_TOKEN,
          refresh_token: REFRESH_TOKEN,
        },
      },
    ]);
    expect(storage.getItem(`${authStorageKey}-code-verifier`)).toBeNull();
    expect(window.sessionStorage.getItem("unrelated")).toBe("keep");
    expect(document.querySelector("form")).toBeNull();
  });

  it("exchanges the server-copied provider code after the callback URL was scrubbed", async () => {
    const config = createConfig();
    mountConfig({
      ...config,
      mode: "code",
      code: "server-copied-code",
    });
    const storage = createNamespacedSessionStorage(config.storageNamespace, window.sessionStorage);
    storage.setItem(`${ceremonyAuthStorageKey(config)}-code-verifier`, "verifier");
    window.history.replaceState(null, "", "/auth/mobile/provider-callback");
    const exchangeCodeForSession = vi.fn().mockResolvedValue({
      data: { session: createSession() },
      error: null,
    });
    const replaceState = vi.spyOn(window.history, "replaceState");

    const controller = await runCeremonyEntry({
      document,
      history: window.history,
      location: window.location,
      sessionStorage: window.sessionStorage,
      clientFactory: () => createAuthClient({ exchangeCodeForSession }),
      submitForm: vi.fn(),
    });

    expect(controller).not.toBeNull();
    expect(document.getElementById(CEREMONY_CONFIG_ELEMENT_ID)).toBeNull();
    expect(replaceState.mock.invocationCallOrder[0]).toBeLessThan(
      exchangeCodeForSession.mock.invocationCallOrder[0],
    );
    expect(exchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(exchangeCodeForSession).toHaveBeenCalledWith("server-copied-code");
  });

  it("supports password flows and every enabled OAuth provider", async () => {
    const signInWithPassword = vi.fn().mockResolvedValue({
      data: { session: createSession() },
      error: null,
    });
    const signUp = vi.fn().mockResolvedValue({
      data: { session: null },
      error: null,
    });
    const signInWithOAuth = vi.fn().mockResolvedValue({
      data: { url: "https://example.supabase.co/authorize" },
      error: null,
    });
    const config = createConfig();
    let ceremonyStorage: CeremonyClientOptions["auth"]["storage"] | null = null;

    const controller = createCeremonyController(config, {
      document,
      history: window.history,
      location: window.location,
      sessionStorage: window.sessionStorage,
      clientFactory: (_url, _key, options) => {
        ceremonyStorage = options.auth.storage;
        return createAuthClient({ signInWithPassword, signUp, signInWithOAuth });
      },
      submitForm: vi.fn(),
    });
    if (!ceremonyStorage) {
      throw new Error("Expected ceremony storage to be captured.");
    }
    ceremonyStorage.setItem("temporary", "value");

    await expect(
      controller.signInWithPassword("engineer@example.com", "safe-password"),
    ).resolves.toEqual({ status: "submitted" });
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "engineer@example.com",
      password: "safe-password",
    });
    expect(ceremonyStorage.getItem("temporary")).toBeNull();

    ceremonyStorage.setItem("temporary", "value");
    await expect(controller.signUpWithPassword("engineer@example.com", "safe-password")).resolves.toEqual(
      { status: "verification_required" },
    );
    expect(ceremonyStorage.getItem("temporary")).toBeNull();

    for (const provider of ["google", "azure", "apple"] as const) {
      await expect(controller.signInWithProvider(provider)).resolves.toEqual({
        status: "redirecting",
      });
    }

    expect(signInWithOAuth).toHaveBeenNthCalledWith(1, {
      provider: "google",
      options: { redirectTo: config.providerCallbackUrl },
    });
    expect(signInWithOAuth).toHaveBeenNthCalledWith(2, {
      provider: "azure",
      options: { redirectTo: config.providerCallbackUrl },
    });
    expect(signInWithOAuth).toHaveBeenNthCalledWith(3, {
      provider: "apple",
      options: { redirectTo: config.providerCallbackUrl },
    });
  });

  it("enables fail-safe controls and suppresses duplicate submissions while busy", async () => {
    document.body.innerHTML = [
      '<p data-mobile-auth-status></p>',
      '<form data-mobile-auth-password-form data-mobile-auth-action="sign-in">',
      '<input name="email" data-mobile-auth-interactive disabled>',
      '<input name="password" data-mobile-auth-interactive disabled>',
      '<button type="submit" data-mobile-auth-action="sign-in" data-mobile-auth-interactive disabled>Sign in</button>',
      "</form>",
    ].join("");
    mountConfig(createConfig());
    let releaseRequest = () => {};
    const requestGate = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    const signInWithPassword = vi.fn(async () => {
      await requestGate;
      return {
        data: { session: null },
        error: new Error("authentication rejected"),
      };
    });

    await runCeremonyEntry({
      document,
      history: window.history,
      location: window.location,
      sessionStorage: window.sessionStorage,
      clientFactory: () => createAuthClient({ signInWithPassword }),
    });

    const form = document.querySelector<HTMLFormElement>(
      "[data-mobile-auth-password-form]",
    );
    const email = document.querySelector<HTMLInputElement>('input[name="email"]');
    const password = document.querySelector<HTMLInputElement>('input[name="password"]');
    const submit = document.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (!form || !email || !password || !submit) {
      throw new Error("Expected ceremony controls.");
    }
    expect([email.disabled, password.disabled, submit.disabled]).toEqual([
      false,
      false,
      false,
    ]);

    email.value = "engineer@example.com";
    password.value = "safe-password";
    const submitEvent = () => {
      const event = new Event("submit", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "submitter", { value: submit });
      form.dispatchEvent(event);
    };
    submitEvent();
    submitEvent();

    await vi.waitFor(() => {
      expect(signInWithPassword).toHaveBeenCalledTimes(1);
    });
    expect(document.querySelector("[data-mobile-auth-status]")?.textContent).toBe(
      "Signing in securely…",
    );
    expect([email.disabled, password.disabled, submit.disabled]).toEqual([
      true,
      true,
      true,
    ]);

    releaseRequest();
    await vi.waitFor(() => {
      expect(submit.disabled).toBe(false);
    });
    expect(document.querySelector("[data-mobile-auth-status]")?.textContent).toBe(
      "Sign in could not be completed. Please try again.",
    );
  });

  it("does nothing when the inert configuration document is absent", async () => {
    const clientFactory = vi.fn();

    await expect(
      runCeremonyEntry({
        document,
        history: window.history,
        location: window.location,
        sessionStorage: window.sessionStorage,
        clientFactory,
      }),
    ).resolves.toBeNull();

    expect(clientFactory).not.toHaveBeenCalled();
    expect(document.getElementById(CEREMONY_CONFIG_ELEMENT_ID)).toBeNull();
  });
});
