import { createClient, type Session } from "@supabase/supabase-js";

export const CEREMONY_CONFIG_ELEMENT_ID = "overdrafter-mobile-auth-config";
export const CEREMONY_STORAGE_PREFIX = "overdrafter.mobile-auth.v1";

const CEREMONY_AUTH_STORAGE_KEY = "session";
const PROVIDER_CALLBACK_PATH = "/auth/mobile/provider-callback";
const COMPLETE_PATH = "/auth/mobile/complete";
const PKCE_CODE_VERIFIER_SUFFIX = "-code-verifier";
const TRANSACTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROVIDER_ERROR_PARAMETERS = new Set([
  "cb",
  "error",
  "error_code",
  "error_description",
]);
const PROVIDER_ERRORS = new Set([
  "access_denied",
  "invalid_request",
  "server_error",
  "temporarily_unavailable",
]);

export type MobileAuthProvider = "google" | "azure" | "apple";
export type MobileAuthProviderError =
  | "access_denied"
  | "invalid_request"
  | "server_error"
  | "temporarily_unavailable";

export type CeremonyProviderCallback =
  | {
      mode: "code";
      code: string;
    }
  | {
      mode: "error";
      error: MobileAuthProviderError;
    };

export type CeremonyResult =
  | { status: "submitted" }
  | { status: "verification_required" }
  | { status: "redirecting" }
  | {
      status: "error";
      code:
        | "mobile_auth_invalid_request"
        | "mobile_auth_provider_failed"
        | "mobile_auth_session_invalid"
        | "mobile_auth_service_unavailable";
    };

export type CeremonyConfig = {
  version: 1;
  storageNamespace: string;
  csrf: string;
  supabaseUrl: string;
  supabasePublishableKey: string;
  providerCallbackUrl: string;
  completeUrl: string;
  callback?: CeremonyProviderCallback;
};

type AuthSessionResult = {
  data: {
    session: Session | null;
  } | null;
  error: unknown;
};

type OAuthResult = {
  data: {
    url?: string | null;
  } | null;
  error: unknown;
};

export type CeremonyAuthClient = {
  auth: {
    signInWithPassword(credentials: {
      email: string;
      password: string;
    }): Promise<AuthSessionResult>;
    signUp(credentials: {
      email: string;
      password: string;
    }): Promise<AuthSessionResult>;
    signInWithOAuth(options: {
      provider: MobileAuthProvider;
      options: {
        redirectTo: string;
      };
    }): Promise<OAuthResult>;
    exchangeCodeForSession(code: string): Promise<AuthSessionResult>;
  };
};

export type NamespacedSessionStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
};

export type CeremonyClientOptions = {
  auth: {
    storage: NamespacedSessionStorage;
    storageKey: string;
    persistSession: true;
    flowType: "pkce";
    detectSessionInUrl: false;
    autoRefreshToken: false;
  };
};

export type CeremonyClientFactory = (
  url: string,
  publishableKey: string,
  options: CeremonyClientOptions,
) => CeremonyAuthClient;

type CeremonyDependencies = {
  document?: Document;
  history?: Pick<History, "replaceState">;
  location?: Pick<Location, "href" | "origin" | "pathname">;
  sessionStorage?: Storage;
  clientFactory?: CeremonyClientFactory;
  submitForm?: (form: HTMLFormElement) => void;
};

export type CeremonyController = {
  signInWithPassword(email: string, password: string): Promise<CeremonyResult>;
  signUpWithPassword(email: string, password: string): Promise<CeremonyResult>;
  signInWithProvider(provider: MobileAuthProvider): Promise<CeremonyResult>;
  handleProviderCallback(url?: string): Promise<CeremonyResult>;
  clearCeremonyStorage(): void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonRecord(serialized: string): Record<string, unknown> | null {
  try {
    const candidate: unknown = JSON.parse(serialized);
    return isRecord(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength;
}

function isLoopbackHostname(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function parseSupabaseUrl(value: unknown): string | null {
  if (!isBoundedString(value, 2_048)) {
    return null;
  }

  try {
    const url = new URL(value);
    const usesSecureTransport = url.protocol === "https:";
    const usesLocalTransport = url.protocol === "http:" && isLoopbackHostname(url.hostname);

    if (!usesSecureTransport && !usesLocalTransport) {
      return null;
    }

    if (
      url.href !== url.origin + "/" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

function parseSameOriginEndpoint(
  value: unknown,
  documentOrigin: string,
  expectedPath: string,
): string | null {
  if (!isBoundedString(value, 2_048)) {
    return null;
  }

  try {
    const url = new URL(value, documentOrigin);

    if (url.origin !== documentOrigin || url.pathname !== expectedPath) {
      return null;
    }

    if (url.username || url.password || url.search || url.hash) {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}

function parseProviderCallbackEndpoint(
  value: unknown,
  documentOrigin: string,
): string | null {
  if (!isBoundedString(value, 2_048)) {
    return null;
  }

  try {
    const url = new URL(value, documentOrigin);
    const callbackBindings = url.searchParams.getAll("cb");
    const callbackBinding = callbackBindings.length === 1 ? callbackBindings[0] : null;

    if (
      url.origin !== documentOrigin ||
      url.pathname !== PROVIDER_CALLBACK_PATH ||
      url.username ||
      url.password ||
      url.hash ||
      !callbackBinding ||
      !TRANSACTION_ID_PATTERN.test(callbackBinding) ||
      url.search !== `?cb=${callbackBinding}`
    ) {
      return null;
    }

    return url.href;
  } catch {
    return null;
  }
}

function resolveDocument(dependencies: CeremonyDependencies): Document | null {
  if (dependencies.document) {
    return dependencies.document;
  }

  if (typeof document === "undefined") {
    return null;
  }

  return document;
}

function resolveHistory(dependencies: CeremonyDependencies): Pick<History, "replaceState"> | null {
  if (dependencies.history) {
    return dependencies.history;
  }

  if (typeof window === "undefined") {
    return null;
  }

  return window.history;
}

function resolveLocation(
  dependencies: CeremonyDependencies,
): Pick<Location, "href" | "origin" | "pathname"> | null {
  if (dependencies.location) {
    return dependencies.location;
  }

  if (typeof window === "undefined") {
    return null;
  }

  return window.location;
}

function resolveSessionStorage(dependencies: CeremonyDependencies): Storage | null {
  if (dependencies.sessionStorage) {
    return dependencies.sessionStorage;
  }

  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Restricts Supabase ceremony state to one server-issued transaction namespace.
 */
export function createNamespacedSessionStorage(
  namespace: string,
  storage: Storage,
): NamespacedSessionStorage {
  if (!/^[A-Za-z0-9.:-]{1,160}$/.test(namespace)) {
    throw new Error("Invalid mobile authentication storage namespace.");
  }

  const prefix = `${CEREMONY_STORAGE_PREFIX}:${namespace}:`;
  const namespacedKey = (key: string) => `${prefix}${key}`;
  const memory = new Map<string, string>();
  const shouldPersist = (key: string) => key.endsWith(PKCE_CODE_VERIFIER_SUFFIX);

  return {
    getItem(key) {
      if (!shouldPersist(key)) {
        return memory.get(key) ?? null;
      }

      try {
        return storage.getItem(namespacedKey(key));
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      if (!shouldPersist(key)) {
        memory.set(key, value);
        return;
      }

      try {
        storage.setItem(namespacedKey(key), value);
      } catch {
        // A later verifier lookup will fail closed.
      }
    },
    removeItem(key) {
      memory.delete(key);
      if (!shouldPersist(key)) {
        return;
      }

      try {
        storage.removeItem(namespacedKey(key));
      } catch {
        // Storage may be unavailable in restricted browser contexts.
      }
    },
    clear() {
      const matchingKeys: string[] = [];
      memory.clear();

      try {
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (key?.startsWith(prefix)) {
            matchingKeys.push(key);
          }
        }

        for (const key of matchingKeys) {
          storage.removeItem(key);
        }
      } catch {
        // Storage may be unavailable in restricted browser contexts.
      }
    },
  };
}

/**
 * Removes and parses the server-rendered inert ceremony payload.
 */
export function readCeremonyConfig(
  sourceDocument: Document,
  elementId = CEREMONY_CONFIG_ELEMENT_ID,
): CeremonyConfig | null {
  const element = sourceDocument.getElementById(elementId);
  if (!element) {
    return null;
  }

  const serializedConfig = element.textContent;
  element.remove();

  if (!serializedConfig) {
    return null;
  }

  const candidate = parseJsonRecord(serializedConfig);
  if (!candidate || candidate.version !== 1) {
    return null;
  }

  const documentOrigin = sourceDocument.location.origin;
  const supabaseUrl = parseSupabaseUrl(candidate.supabaseUrl);
  const providerCallbackUrl = parseProviderCallbackEndpoint(
    candidate.providerCallbackUrl,
    documentOrigin,
  );
  const completeUrl = parseSameOriginEndpoint(candidate.completeUrl, documentOrigin, COMPLETE_PATH);

  if (
    typeof candidate.storageNamespace !== "string" ||
    !/^[A-Za-z0-9.:-]{1,160}$/.test(candidate.storageNamespace)
  ) {
    return null;
  }

  if (
    !isBoundedString(candidate.csrf, 43) ||
    !/^[A-Za-z0-9_-]{43}$/.test(candidate.csrf)
  ) {
    return null;
  }

  if (
    !isBoundedString(candidate.supabasePublishableKey, 8_192) ||
    !/^[\x21-\x7e]+$/.test(candidate.supabasePublishableKey)
  ) {
    return null;
  }

  if (!supabaseUrl || !providerCallbackUrl || !completeUrl) {
    return null;
  }

  let callback: CeremonyProviderCallback | undefined;
  if (candidate.mode !== undefined) {
    if (candidate.mode === "code" && isBoundedString(candidate.code, 4_096)) {
      callback = {
        mode: "code",
        code: candidate.code,
      };
    } else if (
      candidate.mode === "error" &&
      (candidate.error === "access_denied" ||
        candidate.error === "invalid_request" ||
        candidate.error === "server_error" ||
        candidate.error === "temporarily_unavailable")
    ) {
      callback = {
        mode: "error",
        error: candidate.error,
      };
    } else {
      return null;
    }
  }

  const config: CeremonyConfig = {
    version: 1,
    storageNamespace: candidate.storageNamespace,
    csrf: candidate.csrf,
    supabaseUrl,
    supabasePublishableKey: candidate.supabasePublishableKey,
    providerCallbackUrl,
    completeUrl,
  };

  if (callback) {
    config.callback = callback;
  }

  return config;
}

function defaultClientFactory(
  url: string,
  publishableKey: string,
  options: CeremonyClientOptions,
): CeremonyAuthClient {
  return createClient(url, publishableKey, options) as unknown as CeremonyAuthClient;
}

function appendHiddenField(form: HTMLFormElement, name: string, value: string) {
  const input = form.ownerDocument.createElement("input");
  input.type = "hidden";
  input.name = name;
  input.value = value;
  form.append(input);
}

function isUsableSession(session: Session | null | undefined): session is Session {
  return (
    Boolean(session) &&
    isBoundedString(session?.access_token, 16_384) &&
    isBoundedString(session?.refresh_token, 8_192)
  );
}

function isProvider(value: string): value is MobileAuthProvider {
  return value === "google" || value === "azure" || value === "apple";
}

function validPasswordCredentials(email: string, password: string) {
  return email.length > 0 && email.length <= 320 && password.length > 0 && password.length <= 4_096;
}

type ProviderCallbackAnalysis = {
  callbackUrl: URL;
  codeValues: string[];
  errorValues: string[];
  hasNoUrlParameters: boolean;
  hasBoundCodeParameters: boolean;
  hasBoundProviderErrorParameters: boolean;
};

function readExpectedCallbackBinding(expectedUrl: URL): string | null {
  const bindings = expectedUrl.searchParams.getAll("cb");
  const binding = bindings.length === 1 ? bindings[0] : null;
  if (
    !binding ||
    !TRANSACTION_ID_PATTERN.test(binding) ||
    expectedUrl.search !== `?cb=${binding}` ||
    expectedUrl.username ||
    expectedUrl.password ||
    expectedUrl.hash
  ) {
    return null;
  }

  return binding;
}

function analyzeProviderCallback(
  value: string,
  expectedProviderCallbackUrl: string,
): ProviderCallbackAnalysis | null {
  const expectedUrl = new URL(expectedProviderCallbackUrl);
  const expectedCallbackBinding = readExpectedCallbackBinding(expectedUrl);
  let callbackUrl: URL;

  try {
    callbackUrl = new URL(value);
  } catch {
    return null;
  }

  if (
    !expectedCallbackBinding ||
    callbackUrl.origin !== expectedUrl.origin ||
    callbackUrl.pathname !== expectedUrl.pathname ||
    callbackUrl.username ||
    callbackUrl.password
  ) {
    return null;
  }

  const codeValues = callbackUrl.searchParams.getAll("code");
  const callbackBindings = callbackUrl.searchParams.getAll("cb");
  const errorValues = callbackUrl.searchParams.getAll("error");
  const parameterNames = Array.from(callbackUrl.searchParams.keys());
  const uniqueParameterNames = new Set(parameterNames);
  const hasDuplicateParameter = uniqueParameterNames.size !== parameterNames.length;
  const hasMatchingCallbackBinding =
    callbackBindings.length === 1 && callbackBindings[0] === expectedCallbackBinding;
  const hasSharedRequirements =
    !callbackUrl.hash && !hasDuplicateParameter && hasMatchingCallbackBinding;

  return {
    callbackUrl,
    codeValues,
    errorValues,
    hasNoUrlParameters: parameterNames.length === 0,
    hasBoundCodeParameters:
      hasSharedRequirements &&
      parameterNames.length === 2 &&
      codeValues.length === 1 &&
      isBoundedString(codeValues[0], 4_096) &&
      parameterNames.every((name) => name === "cb" || name === "code"),
    hasBoundProviderErrorParameters:
      hasSharedRequirements &&
      errorValues.length === 1 &&
      PROVIDER_ERRORS.has(errorValues[0]) &&
      codeValues.length === 0 &&
      parameterNames.every((name) => PROVIDER_ERROR_PARAMETERS.has(name)),
  };
}

/**
 * Creates the isolated password/provider ceremony controller for one transaction.
 */
export function createCeremonyController(
  config: CeremonyConfig,
  dependencies: CeremonyDependencies = {},
): CeremonyController {
  const sourceDocument = resolveDocument(dependencies);
  const sourceHistory = resolveHistory(dependencies);
  const sourceLocation = resolveLocation(dependencies);
  const browserStorage = resolveSessionStorage(dependencies);

  if (!sourceDocument || !sourceHistory || !sourceLocation || !browserStorage) {
    throw new Error("Mobile authentication ceremony requires a browser document.");
  }

  const storage = createNamespacedSessionStorage(config.storageNamespace, browserStorage);
  const authStorageKey = `${CEREMONY_AUTH_STORAGE_KEY}:${config.storageNamespace}`;
  const clientFactory = dependencies.clientFactory ?? defaultClientFactory;
  const client = clientFactory(config.supabaseUrl, config.supabasePublishableKey, {
    auth: {
      storage,
      storageKey: authStorageKey,
      persistSession: true,
      flowType: "pkce",
      detectSessionInUrl: false,
      autoRefreshToken: false,
    },
  });
  const submitForm =
    dependencies.submitForm ??
    ((form: HTMLFormElement) => {
      form.submit();
    });

  let providerCallbackPromise: Promise<CeremonyResult> | null = null;

  const clearCeremonyStorage = () => {
    storage.clear();
  };

  const completeWithSession = async (session: Session): Promise<CeremonyResult> => {
    if (!isUsableSession(session) || !sourceDocument.body) {
      clearCeremonyStorage();
      return {
        status: "error",
        code: "mobile_auth_session_invalid",
      };
    }

    const form = sourceDocument.createElement("form");
    form.method = "post";
    form.action = config.completeUrl;
    form.target = "_self";
    form.enctype = "application/x-www-form-urlencoded";

    appendHiddenField(form, "v", String(config.version));
    appendHiddenField(form, "csrf", config.csrf);
    appendHiddenField(form, "access_token", session.access_token);
    appendHiddenField(form, "refresh_token", session.refresh_token);

    clearCeremonyStorage();
    sourceDocument.body.append(form);

    try {
      submitForm(form);
      return { status: "submitted" };
    } catch {
      return {
        status: "error",
        code: "mobile_auth_service_unavailable",
      };
    } finally {
      for (const element of Array.from(form.elements)) {
        if (element instanceof HTMLInputElement) {
          element.value = "";
        }
      }
      session.access_token = "";
      session.refresh_token = "";
      form.remove();
    }
  };

  const signInWithPassword = async (
    email: string,
    password: string,
  ): Promise<CeremonyResult> => {
    if (!validPasswordCredentials(email, password)) {
      return {
        status: "error",
        code: "mobile_auth_invalid_request",
      };
    }

    try {
      const result = await client.auth.signInWithPassword({ email, password });
      if (result.error || !isUsableSession(result.data?.session)) {
        return {
          status: "error",
          code: "mobile_auth_provider_failed",
        };
      }

      return completeWithSession(result.data.session);
    } catch {
      return {
        status: "error",
        code: "mobile_auth_service_unavailable",
      };
    }
  };

  const signUpWithPassword = async (
    email: string,
    password: string,
  ): Promise<CeremonyResult> => {
    if (!validPasswordCredentials(email, password)) {
      return {
        status: "error",
        code: "mobile_auth_invalid_request",
      };
    }

    try {
      const result = await client.auth.signUp({ email, password });
      if (result.error) {
        return {
          status: "error",
          code: "mobile_auth_provider_failed",
        };
      }

      if (isUsableSession(result.data?.session)) {
        return completeWithSession(result.data.session);
      }

      clearCeremonyStorage();
      return { status: "verification_required" };
    } catch {
      return {
        status: "error",
        code: "mobile_auth_service_unavailable",
      };
    }
  };

  const signInWithProvider = async (provider: MobileAuthProvider): Promise<CeremonyResult> => {
    try {
      const result = await client.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: config.providerCallbackUrl,
        },
      });

      if (result.error) {
        return {
          status: "error",
          code: "mobile_auth_provider_failed",
        };
      }

      return { status: "redirecting" };
    } catch {
      return {
        status: "error",
        code: "mobile_auth_service_unavailable",
      };
    }
  };

  const processProviderCallback = async (url: string): Promise<CeremonyResult> => {
    const expectedUrl = new URL(config.providerCallbackUrl);
    const analysis = analyzeProviderCallback(url, config.providerCallbackUrl);
    if (!analysis) {
      return {
        status: "error",
        code: "mobile_auth_invalid_request",
      };
    }

    const {
      callbackUrl,
      codeValues,
      errorValues,
      hasNoUrlParameters,
      hasBoundCodeParameters,
      hasBoundProviderErrorParameters,
    } = analysis;

    sourceHistory.replaceState(null, "", expectedUrl.pathname);

    if (config.callback?.mode === "error") {
      const hasMatchingProviderError =
        hasBoundProviderErrorParameters && errorValues[0] === config.callback.error;
      if (!hasNoUrlParameters && !hasMatchingProviderError) {
        clearCeremonyStorage();
        return {
          status: "error",
          code: "mobile_auth_invalid_request",
        };
      }

      clearCeremonyStorage();
      return {
        status: "error",
        code: "mobile_auth_provider_failed",
      };
    }

    if (config.callback?.mode === "code") {
      const hasMatchingCodeParameter =
        hasBoundCodeParameters && codeValues[0] === config.callback.code;
      if (callbackUrl.hash || (!hasNoUrlParameters && !hasMatchingCodeParameter)) {
        clearCeremonyStorage();
        return {
          status: "error",
          code: "mobile_auth_invalid_request",
        };
      }
    }

    if (config.callback === undefined && hasBoundProviderErrorParameters) {
      clearCeremonyStorage();
      return {
        status: "error",
        code: "mobile_auth_provider_failed",
      };
    }

    if (config.callback === undefined && !hasBoundCodeParameters) {
      clearCeremonyStorage();
      return {
        status: "error",
        code: "mobile_auth_invalid_request",
      };
    }

    const code = config.callback?.mode === "code" ? config.callback.code : codeValues[0];
    if (!isBoundedString(code, 4_096)) {
      clearCeremonyStorage();
      return {
        status: "error",
        code: "mobile_auth_invalid_request",
      };
    }

    const verifier = storage.getItem(`${authStorageKey}${PKCE_CODE_VERIFIER_SUFFIX}`);
    if (!isBoundedString(verifier, 4_096)) {
      clearCeremonyStorage();
      return {
        status: "error",
        code: "mobile_auth_provider_failed",
      };
    }

    try {
      const result = await client.auth.exchangeCodeForSession(code);
      if (result.error || !isUsableSession(result.data?.session)) {
        clearCeremonyStorage();
        return {
          status: "error",
          code: "mobile_auth_provider_failed",
        };
      }

      return completeWithSession(result.data.session);
    } catch {
      clearCeremonyStorage();
      return {
        status: "error",
        code: "mobile_auth_service_unavailable",
      };
    }
  };

  return {
    signInWithPassword,
    signUpWithPassword,
    signInWithProvider,
    handleProviderCallback(url = sourceLocation.href) {
      if (!providerCallbackPromise) {
        providerCallbackPromise = processProviderCallback(url);
      }

      return providerCallbackPromise;
    },
    clearCeremonyStorage,
  };
}

function updateStatus(sourceDocument: Document, result: CeremonyResult) {
  const statusElement = sourceDocument.querySelector<HTMLElement>("[data-mobile-auth-status]");
  if (!statusElement) {
    return;
  }

  if (result.status === "verification_required") {
    statusElement.textContent = "Check your email, then start sign in again.";
    return;
  }

  if (result.status === "redirecting") {
    statusElement.textContent = "Opening secure sign in…";
    return;
  }

  if (result.status === "error") {
    statusElement.textContent = "Sign in could not be completed. Please try again.";
  }
}

function updateProgress(sourceDocument: Document, message: string) {
  const statusElement = sourceDocument.querySelector<HTMLElement>(
    "[data-mobile-auth-status]",
  );
  if (statusElement) {
    statusElement.textContent = message;
  }
}

function bindCeremonyControls(sourceDocument: Document, controller: CeremonyController) {
  const interactiveControls =
    sourceDocument.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
      "[data-mobile-auth-interactive]",
    );
  let busy = false;
  const setControlsDisabled = (disabled: boolean) => {
    for (const control of interactiveControls) {
      control.disabled = disabled;
    }
    sourceDocument
      .querySelector<HTMLElement>(".mobile-auth-card")
      ?.setAttribute("aria-busy", String(disabled));
  };
  const resultAllowsRetry = (result: CeremonyResult) =>
    result.status === "error" || result.status === "verification_required";

  setControlsDisabled(false);

  const passwordForms =
    sourceDocument.querySelectorAll<HTMLFormElement>("[data-mobile-auth-password-form]");

  for (const form of passwordForms) {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (busy) {
        return;
      }
      const formData = new FormData(form);
      const email = formData.get("email");
      const password = formData.get("password");
      const submitter = event.submitter;
      let action = form.dataset.mobileAuthAction;

      if (submitter instanceof HTMLElement && submitter.dataset.mobileAuthAction) {
        action = submitter.dataset.mobileAuthAction;
      }
      busy = true;
      setControlsDisabled(true);
      updateProgress(
        sourceDocument,
        action === "sign-up" ? "Creating your account…" : "Signing in securely…",
      );

      void (async () => {
        if (typeof email !== "string" || typeof password !== "string") {
          const result: CeremonyResult = {
            status: "error",
            code: "mobile_auth_invalid_request",
          };
          updateStatus(sourceDocument, result);
          busy = false;
          setControlsDisabled(false);
          return;
        }

        let result: CeremonyResult;
        if (action === "sign-up") {
          result = await controller.signUpWithPassword(email, password);
        } else {
          result = await controller.signInWithPassword(email, password);
        }
        updateStatus(sourceDocument, result);
        if (resultAllowsRetry(result)) {
          busy = false;
          setControlsDisabled(false);
        }
      })();
    });
  }

  const providerControls =
    sourceDocument.querySelectorAll<HTMLElement>("[data-mobile-auth-provider]");

  for (const control of providerControls) {
    control.addEventListener("click", () => {
      if (busy) {
        return;
      }
      busy = true;
      setControlsDisabled(true);
      updateProgress(sourceDocument, "Opening secure sign in…");

      void (async () => {
        const provider = control.dataset.mobileAuthProvider;
        if (!provider || !isProvider(provider)) {
          const result: CeremonyResult = {
            status: "error",
            code: "mobile_auth_invalid_request",
          };
          updateStatus(sourceDocument, result);
          busy = false;
          setControlsDisabled(false);
          return;
        }

        const result = await controller.signInWithProvider(provider);
        updateStatus(sourceDocument, result);
        if (resultAllowsRetry(result)) {
          busy = false;
          setControlsDisabled(false);
        }
      })();
    });
  }
}

/**
 * Starts the callback exchange or binds the server-rendered ceremony controls.
 */
export async function runCeremonyEntry(
  dependencies: CeremonyDependencies = {},
): Promise<CeremonyController | null> {
  const sourceDocument = resolveDocument(dependencies);
  const sourceLocation = resolveLocation(dependencies);

  if (!sourceDocument || !sourceLocation) {
    return null;
  }

  const config = readCeremonyConfig(sourceDocument);
  if (!config) {
    return null;
  }

  try {
    const controller = createCeremonyController(config, dependencies);
    const callbackUrl = new URL(config.providerCallbackUrl);

    if (
      sourceLocation.origin === callbackUrl.origin &&
      sourceLocation.pathname === callbackUrl.pathname
    ) {
      const result = await controller.handleProviderCallback(sourceLocation.href);
      updateStatus(sourceDocument, result);
      return controller;
    }

    bindCeremonyControls(sourceDocument, controller);
    return controller;
  } catch {
    return null;
  }
}
