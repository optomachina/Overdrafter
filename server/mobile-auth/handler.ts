import { randomUUID } from "node:crypto";
import {
  MOBILE_AUTH_BOOTSTRAP_HEADER,
  MOBILE_AUTH_CONTRACT_VERSION,
  MOBILE_AUTH_LIFETIMES,
  MOBILE_AUTH_LIMITS,
  MOBILE_AUTH_MESSAGE_VERSION,
  MOBILE_AUTH_PATHS,
  MOBILE_AUTH_RATE_LIMITS,
  type MobileAuthErrorCode,
  type MobileAuthKeyedDigest,
  type MobileAuthRetryInstruction,
} from "./contract";
import {
  createBrowserBindingLookupCandidates,
  createMobileAuthBindingDigests,
  createMobileAuthBrowserBinding,
  createRateLimitDigest,
  readMobileAuthCookie,
  serializeExpiredMobileAuthCookie,
  serializeMobileAuthCookie,
  verifyMobileAuthCsrf,
} from "./cookies";
import {
  calculateS256CodeChallenge,
  constantTimeEqual,
  createCurrentHmacDigest,
  createHmacLookupCandidates,
  createMobileAuthHandoffCode,
} from "./crypto";
import {
  createMobileAuthStorageNamespace,
  renderMobileAuthBootstrapFailureDocument,
  renderMobileAuthBootstrapSuccessDocument,
  renderMobileAuthCeremonyDocument,
  renderMobileAuthProviderCallbackDocument,
  renderMobileAuthRecoveryDocument,
  type MobileAuthHtmlDocument,
} from "./documents";
import {
  openSessionEnvelope,
  openStateEnvelope,
  sealSessionEnvelope,
  sealStateEnvelope,
} from "./envelopes";
import {
  parseBootstrapRequest,
  parseCompleteRequest,
  parseProviderCallbackRequest,
  parseStartRequest,
  type ParsedBootstrapRequest,
} from "./parsing";
import type {
  BrowserMobileAuthTransaction,
  MobileAuthAuditEvent,
  MobileAuthRepository,
  PreparedMobileAuthBootstrap,
} from "./repository";
import {
  readTrustedClientIp,
  resolveMobileAuthRoute,
  type MobileAuthAction,
  type ResolvedMobileAuthRoute,
} from "./request-routing";
import type { MobileAuthRuntimeConfig } from "./runtime-config";
import type {
  TransferSessionVerifier,
  VerifiedTransferSession,
} from "./supabase-transfer";

export interface MobileAuthHandlerDependencies {
  readonly config: MobileAuthRuntimeConfig;
  readonly repository: MobileAuthRepository;
  readonly transferVerifier: TransferSessionVerifier;
  readonly now?: () => number;
}

interface PublicFailure {
  readonly code: MobileAuthErrorCode;
  readonly retry: MobileAuthRetryInstruction;
  readonly status: number;
  readonly retryAfterSeconds?: number;
}

const METHOD_BY_ACTION: Readonly<Record<MobileAuthAction, "GET" | "POST">> = {
  start: "GET",
  "provider-callback": "GET",
  complete: "POST",
  callback: "GET",
  bootstrap: "POST",
  cleanup: "GET",
};

const ZERO_STATE = Buffer.alloc(MOBILE_AUTH_LIMITS.stateBytes).toString("base64url");
const CLEANUP_BATCH_SIZE = 250;
const CLEANUP_MAX_BATCHES = 40;
const CLEANUP_MAX_DURATION_MILLISECONDS = 8_000;

async function cleanupWithinDeadline(
  repository: MobileAuthRepository,
  deadline: number,
): Promise<Awaited<ReturnType<MobileAuthRepository["cleanup"]>> | null> {
  const remainingMilliseconds = deadline - Date.now();
  if (remainingMilliseconds <= 0) {
    return null;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadlineReached = new Promise<null>((resolve) => {
    timeout = setTimeout(() => resolve(null), remainingMilliseconds);
  });

  try {
    return await Promise.race([
      repository.cleanup(CLEANUP_BATCH_SIZE),
      deadlineReached,
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function documentResponse(
  document: MobileAuthHtmlDocument,
  status = 200,
  additionalHeaders: Readonly<Record<string, string>> = {},
): Response {
  const headers = new Headers(document.headers);
  for (const [name, value] of Object.entries(additionalHeaders)) {
    headers.set(name, value);
  }

  return new Response(document.body, { status, headers });
}

function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      Pragma: "no-cache",
      "Referrer-Policy": "no-referrer",
      "Set-Cookie": serializeExpiredMobileAuthCookie(),
      Location: location,
    },
  });
}

function recoveryResponse(
  status: number,
  additionalHeaders: Readonly<Record<string, string>> = {},
): Response {
  return documentResponse(renderMobileAuthRecoveryDocument(), status, additionalHeaders);
}

function bootstrapFailureResponse(
  config: MobileAuthRuntimeConfig,
  state: string,
  failure: PublicFailure,
): Response {
  const headers: Record<string, string> = {};
  if (failure.retryAfterSeconds !== undefined) {
    headers["Retry-After"] = String(failure.retryAfterSeconds);
  }

  return documentResponse(
    renderMobileAuthBootstrapFailureDocument({
      state,
      code: failure.code,
      retry: failure.retry,
      supabaseUrl: config.supabaseOrigin,
    }),
    failure.status,
    headers,
  );
}

function durationBucket(startedAt: number, finishedAt: number): string {
  const elapsed = Math.max(0, finishedAt - startedAt);
  if (elapsed < 100) {
    return "lt_100ms";
  }
  if (elapsed < 500) {
    return "100_499ms";
  }
  if (elapsed < 2_000) {
    return "500_1999ms";
  }
  if (elapsed < 10_000) {
    return "2_9s";
  }
  if (elapsed < 60_000) {
    return "10_59s";
  }
  if (elapsed < 600_000) {
    return "1_9m";
  }

  return "gte_10m";
}

async function recordAuditSafely(
  repository: MobileAuthRepository,
  event: MobileAuthAuditEvent,
): Promise<void> {
  try {
    await repository.recordAuditEvent(event);
  } catch {
    // Authentication authority never depends on telemetry availability.
  }
}

function validateBrowserTransaction(
  transaction: BrowserMobileAuthTransaction,
  config: MobileAuthRuntimeConfig,
): boolean {
  return (
    transaction.contractVersion === MOBILE_AUTH_MESSAGE_VERSION &&
    transaction.pkceMethod === "S256" &&
    transaction.providerCallbackPath === MOBILE_AUTH_PATHS.providerCallback &&
    transaction.callbackOrigin === config.appOrigin &&
    transaction.callbackPath === MOBILE_AUTH_PATHS.callback
  );
}

async function findBrowserTransaction(
  request: Request,
  repository: MobileAuthRepository,
  config: MobileAuthRuntimeConfig,
): Promise<BrowserMobileAuthTransaction | null> {
  const cookie = readMobileAuthCookie(request.headers.get("cookie"));
  const candidates = createBrowserBindingLookupCandidates(
    config.masterKeyring,
    cookie,
  );
  const transaction = await repository.findBrowserTransaction(
    cookie.transactionId,
    candidates.map((candidate) => candidate.digest),
  );
  if (!transaction || !validateBrowserTransaction(transaction, config)) {
    return null;
  }

  const matchedCandidate = candidates.find(
    (candidate) => candidate.digest === transaction.browserBindingDigest,
  );
  if (
    matchedCandidate?.keyVersion !== transaction.cryptoKeyVersion
  ) {
    return null;
  }

  return transaction;
}

function digestForVersion(
  candidates: readonly MobileAuthKeyedDigest[],
  keyVersion: number,
): MobileAuthKeyedDigest | null {
  return candidates.find((candidate) => candidate.keyVersion === keyVersion) ?? null;
}

async function takeRateLimit(
  repository: MobileAuthRepository,
  config: MobileAuthRuntimeConfig,
  scope: "start_ip" | "bootstrap_ip" | "bootstrap_handoff",
  value: string,
  policy: { attempts: number; windowSeconds: number },
) {
  const digest = createRateLimitDigest(config.masterKeyring, `${scope}:${value}`);
  return repository.takeRateLimit({
    scope,
    keyVersion: digest.keyVersion,
    keyDigest: digest.digest,
    windowSeconds: policy.windowSeconds,
    limit: policy.attempts,
  });
}

function parseEpochSeconds(value: string): number | null {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    return null;
  }

  const seconds = Math.floor(milliseconds / 1_000);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}

function bootstrapFailure(
  code: MobileAuthErrorCode,
  status: number,
  retry: MobileAuthRetryInstruction = "restart",
  retryAfterSeconds?: number,
): PublicFailure {
  return { code, status, retry, retryAfterSeconds };
}

function isInvalidRequestFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  return error.code === "mobile_auth_invalid_request";
}

function methodFailure(action: MobileAuthAction): Response {
  return recoveryResponse(405, { Allow: METHOD_BY_ACTION[action] });
}

function queryMustBeEmpty(route: ResolvedMobileAuthRoute): boolean {
  return route.publicUrl.search === "";
}

async function handleCallback(route: ResolvedMobileAuthRoute): Promise<Response> {
  if (!queryMustBeEmpty(route)) {
    return recoveryResponse(400);
  }

  return documentResponse(renderMobileAuthRecoveryDocument());
}

function isNativeBootstrapRequest(
  request: Request,
  config: MobileAuthRuntimeConfig,
): boolean {
  if (
    request.headers.get(MOBILE_AUTH_BOOTSTRAP_HEADER.name) !==
    MOBILE_AUTH_BOOTSTRAP_HEADER.value
  ) {
    return false;
  }

  const origin = request.headers.get("origin");
  if (origin !== null && origin !== config.appOrigin) {
    return false;
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  return (
    fetchSite === null ||
    fetchSite === "none" ||
    fetchSite === "same-origin"
  );
}

function makeSessionContext(
  transaction: PreparedMobileAuthBootstrap,
  config: MobileAuthRuntimeConfig,
) {
  return {
    transactionId: transaction.transactionId,
    pkceChallenge: transaction.pkceChallenge,
    callbackOrigin: config.appOrigin,
    callbackPath: MOBILE_AUTH_PATHS.callback,
    returnTo: transaction.returnTo,
    subjectId: transaction.verifiedUserId,
    sourceSessionId: transaction.sourceSessionId,
  } as const;
}

function makeBoundProviderCallbackUrl(
  config: MobileAuthRuntimeConfig,
  transactionId: string,
): string {
  const callbackUrl = new URL(config.providerCallbackUrl);
  callbackUrl.searchParams.set("cb", transactionId);
  return callbackUrl.toString();
}

/**
 * Builds the sole same-origin HTTP boundary for the website-mediated mobile
 * authentication ceremony.
 */
export function createMobileAuthHandler(
  dependencies: MobileAuthHandlerDependencies,
): (request: Request) => Promise<Response> {
  const { config, repository, transferVerifier } = dependencies;
  const now = dependencies.now ?? Date.now;

  async function handleStart(
    request: Request,
    route: ResolvedMobileAuthRoute,
  ): Promise<Response> {
    const startedAt = now();
    const traceId = randomUUID();
    const rateLimit = await takeRateLimit(
      repository,
      config,
      "start_ip",
      readTrustedClientIp(request.headers),
      MOBILE_AUTH_RATE_LIMITS.start,
    );
    if (!rateLimit.allowed) {
      await recordAuditSafely(repository, {
        traceId,
        eventType: "start_rejected",
        contractVersion: MOBILE_AUTH_MESSAGE_VERSION,
        environment: config.environment,
        failureCode: "mobile_auth_rate_limited",
        durationBucket: durationBucket(startedAt, now()),
      });
      return recoveryResponse(429, {
        "Retry-After": String(rateLimit.retryAfterSeconds),
      });
    }

    const parsed = parseStartRequest(route.publicUrl);
    const binding = createMobileAuthBrowserBinding();
    const bindingDigests = createMobileAuthBindingDigests(
      config.masterKeyring,
      binding,
    );
    const stateDigest = createCurrentHmacDigest(
      config.masterKeyring,
      "state-lookup",
      parsed.state,
    );
    const storageNamespace = createMobileAuthStorageNamespace(binding.transactionId);
    const browserExpiresAt =
      Math.floor(now() / 1_000) + MOBILE_AUTH_LIFETIMES.browserSeconds;
    const stateEnvelope = sealStateEnvelope(
      config.masterKeyring,
      parsed.state,
      binding.csrf,
      browserExpiresAt,
      {
        transactionId: binding.transactionId,
        pkceChallenge: parsed.codeChallenge,
        callbackOrigin: config.appOrigin,
        callbackPath: MOBILE_AUTH_PATHS.callback,
        returnTo: parsed.returnTo,
      },
    );
    const created = await repository.createTransaction({
      transactionId: binding.transactionId,
      traceId,
      contractVersion: Number(MOBILE_AUTH_CONTRACT_VERSION),
      cryptoKeyVersion: stateDigest.keyVersion,
      stateDigest: stateDigest.digest,
      stateEnvelope,
      pkceChallenge: parsed.codeChallenge,
      browserBindingDigest: bindingDigests.browser.digest,
      csrfDigest: bindingDigests.csrf.digest,
      storageNamespace,
      providerCallbackPath: MOBILE_AUTH_PATHS.providerCallback,
      callbackOrigin: config.appOrigin,
      callbackPath: MOBILE_AUTH_PATHS.callback,
      returnTo: parsed.returnTo,
    });
    if (!created) {
      throw new Error("Mobile authentication transaction creation failed.");
    }

    const document = renderMobileAuthCeremonyDocument({
      storageNamespace,
      csrf: binding.csrf,
      supabaseUrl: config.supabaseOrigin,
      supabasePublishableKey: config.supabasePublishableKey,
      providerCallbackUrl: makeBoundProviderCallbackUrl(
        config,
        binding.transactionId,
      ),
      completeUrl: new URL(MOBILE_AUTH_PATHS.complete, config.appOrigin).toString(),
    });
    await recordAuditSafely(repository, {
      traceId,
      eventType: "start_accepted",
      contractVersion: MOBILE_AUTH_MESSAGE_VERSION,
      environment: config.environment,
      durationBucket: durationBucket(startedAt, now()),
    });

    return documentResponse(document, 200, {
      "Set-Cookie": serializeMobileAuthCookie(binding),
    });
  }

  async function handleProviderCallback(
    request: Request,
    route: ResolvedMobileAuthRoute,
  ): Promise<Response> {
    const transaction = await findBrowserTransaction(request, repository, config);
    if (!transaction) {
      return recoveryResponse(400, {
        "Set-Cookie": serializeExpiredMobileAuthCookie(),
      });
    }

    const callback = parseProviderCallbackRequest(route.publicUrl);
    if (callback.callbackBinding !== transaction.transactionId) {
      return recoveryResponse(403);
    }

    const stateEnvelope = openStateEnvelope(
      config.masterKeyring,
      transaction.stateEnvelope,
      {
        transactionId: transaction.transactionId,
        pkceChallenge: transaction.pkceChallenge,
        callbackOrigin: config.appOrigin,
        callbackPath: MOBILE_AUTH_PATHS.callback,
        returnTo: transaction.returnTo,
      },
    );
    if (callback.kind === "error") {
      await repository.terminateTransaction(
        transaction.transactionId,
        transaction.rowVersion,
        "failed",
        "mobile_auth_provider_failed",
      );
      await recordAuditSafely(repository, {
        traceId: transaction.traceId,
        eventType: "browser_auth_failed",
        contractVersion: transaction.contractVersion,
        environment: config.environment,
        failureCode: "mobile_auth_provider_failed",
      });
    }

    const document = renderMobileAuthProviderCallbackDocument(
      {
        storageNamespace: transaction.storageNamespace,
        csrf: stateEnvelope.csrf,
        supabaseUrl: config.supabaseOrigin,
        supabasePublishableKey: config.supabasePublishableKey,
        providerCallbackUrl: makeBoundProviderCallbackUrl(
          config,
          transaction.transactionId,
        ),
        completeUrl: new URL(MOBILE_AUTH_PATHS.complete, config.appOrigin).toString(),
      },
      callback.kind === "code"
        ? { mode: "code", code: callback.authorizationCode }
        : { mode: "error", error: callback.providerError },
    );

    const headers: Record<string, string> = {};
    if (callback.kind === "error") {
      headers["Set-Cookie"] = serializeExpiredMobileAuthCookie();
    }
    return documentResponse(document, callback.kind === "code" ? 200 : 401, headers);
  }

  async function handleComplete(
    request: Request,
    route: ResolvedMobileAuthRoute,
  ): Promise<Response> {
    if (!queryMustBeEmpty(route)) {
      return recoveryResponse(400);
    }

    const transaction = await findBrowserTransaction(request, repository, config);
    if (!transaction) {
      return recoveryResponse(400, {
        "Set-Cookie": serializeExpiredMobileAuthCookie(),
      });
    }

    const parsed = await parseCompleteRequest(request);
    const csrfDigest: MobileAuthKeyedDigest = {
      algorithm: "HMAC-SHA-256",
      keyVersion: transaction.cryptoKeyVersion,
      purpose: "csrf-binding",
      digest: transaction.csrfDigest,
    };
    if (
      !verifyMobileAuthCsrf(
        config.masterKeyring,
        csrfDigest,
        transaction.transactionId,
        parsed.csrf,
      )
    ) {
      await repository.terminateTransaction(
        transaction.transactionId,
        transaction.rowVersion,
        "failed",
        "mobile_auth_invalid_request",
      );
      return recoveryResponse(403, {
        "Set-Cookie": serializeExpiredMobileAuthCookie(),
      });
    }

    const stateEnvelope = openStateEnvelope(
      config.masterKeyring,
      transaction.stateEnvelope,
      {
        transactionId: transaction.transactionId,
        pkceChallenge: transaction.pkceChallenge,
        callbackOrigin: config.appOrigin,
        callbackPath: MOBILE_AUTH_PATHS.callback,
        returnTo: transaction.returnTo,
      },
    );
    const claimedRowVersion = await repository.claimCompletion({
      transactionId: transaction.transactionId,
      expectedRowVersion: transaction.rowVersion,
      browserBindingDigest: transaction.browserBindingDigest,
      csrfDigest: transaction.csrfDigest,
      cryptoKeyVersion: transaction.cryptoKeyVersion,
    });
    if (claimedRowVersion === null) {
      return recoveryResponse(409, {
        "Set-Cookie": serializeExpiredMobileAuthCookie(),
      });
    }

    let verifiedSession: VerifiedTransferSession | null;
    try {
      verifiedSession = await transferVerifier.verifyAndRotate({
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
      });
    } catch (error) {
      await repository.terminateTransaction(
        transaction.transactionId,
        claimedRowVersion,
        "failed",
        "mobile_auth_service_unavailable",
      );
      throw error;
    }

    if (!verifiedSession) {
      await repository.terminateTransaction(
        transaction.transactionId,
        claimedRowVersion,
        "failed",
        "mobile_auth_session_invalid",
      );
      await recordAuditSafely(repository, {
        traceId: transaction.traceId,
        eventType: "browser_auth_failed",
        contractVersion: transaction.contractVersion,
        environment: config.environment,
        failureCode: "mobile_auth_session_invalid",
      });
      return recoveryResponse(401, {
        "Set-Cookie": serializeExpiredMobileAuthCookie(),
      });
    }

    const handoffCode = createMobileAuthHandoffCode();
    const handoffDigest = digestForVersion(
      createHmacLookupCandidates(
        config.masterKeyring,
        "handoff-lookup",
        handoffCode,
      ),
      transaction.cryptoKeyVersion,
    );
    if (!handoffDigest) {
      throw new Error("Mobile authentication transaction key is unavailable.");
    }

    const handoffExpiresAt =
      Math.floor(now() / 1_000) + MOBILE_AUTH_LIFETIMES.handoffSeconds;
    const sessionEnvelope = sealSessionEnvelope(
      config.masterKeyring,
      transaction.cryptoKeyVersion,
      verifiedSession,
      handoffExpiresAt,
      {
        transactionId: transaction.transactionId,
        pkceChallenge: transaction.pkceChallenge,
        callbackOrigin: config.appOrigin,
        callbackPath: MOBILE_AUTH_PATHS.callback,
        returnTo: transaction.returnTo,
        subjectId: verifiedSession.userId,
        sourceSessionId: verifiedSession.sessionId,
      },
    );
    const completed = await repository.completeTransaction({
      transactionId: transaction.transactionId,
      expectedRowVersion: claimedRowVersion,
      browserBindingDigest: transaction.browserBindingDigest,
      csrfDigest: transaction.csrfDigest,
      cryptoKeyVersion: transaction.cryptoKeyVersion,
      handoffDigest: handoffDigest.digest,
      sessionEnvelope,
      verifiedUserId: verifiedSession.userId,
      sourceSessionId: verifiedSession.sessionId,
      handoffExpiresAt: new Date(handoffExpiresAt * 1_000).toISOString(),
    });
    if (!completed) {
      return recoveryResponse(409, {
        "Set-Cookie": serializeExpiredMobileAuthCookie(),
      });
    }

    await recordAuditSafely(repository, {
      traceId: transaction.traceId,
      eventType: "browser_auth_completed",
      contractVersion: transaction.contractVersion,
      environment: config.environment,
    });
    await recordAuditSafely(repository, {
      traceId: transaction.traceId,
      eventType: "handoff_created",
      contractVersion: transaction.contractVersion,
      environment: config.environment,
    });

    const callback = new URL(MOBILE_AUTH_PATHS.callback, config.appOrigin);
    callback.hash = `code=${handoffCode}&state=${stateEnvelope.state}`;
    return redirectResponse(callback.toString());
  }

  async function rejectBootstrap(
    parsed: ParsedBootstrapRequest,
    failure: PublicFailure,
    traceId: string = randomUUID(),
  ): Promise<Response> {
    await recordAuditSafely(repository, {
      traceId,
      eventType:
        failure.code === "mobile_auth_replayed"
          ? "replay_detected"
          : "bootstrap_rejected",
      contractVersion: MOBILE_AUTH_MESSAGE_VERSION,
      environment: config.environment,
      failureCode: failure.code,
    });
    return bootstrapFailureResponse(config, parsed.state, failure);
  }

  async function handleBootstrap(
    request: Request,
    route: ResolvedMobileAuthRoute,
    rememberState: (state: string) => void,
  ): Promise<Response> {
    if (!queryMustBeEmpty(route) || !isNativeBootstrapRequest(request, config)) {
      return recoveryResponse(403);
    }

    const ipRate = await takeRateLimit(
      repository,
      config,
      "bootstrap_ip",
      readTrustedClientIp(request.headers),
      MOBILE_AUTH_RATE_LIMITS.bootstrap,
    );
    const parsed = await parseBootstrapRequest(request);
    rememberState(parsed.state);
    const handoffRate = await takeRateLimit(
      repository,
      config,
      "bootstrap_handoff",
      parsed.code,
      MOBILE_AUTH_RATE_LIMITS.bootstrap,
    );
    if (!ipRate.allowed || !handoffRate.allowed) {
      return rejectBootstrap(
        parsed,
        bootstrapFailure(
          "mobile_auth_rate_limited",
          429,
          "later",
          Math.max(ipRate.retryAfterSeconds, handoffRate.retryAfterSeconds),
        ),
      );
    }

    const challenge = calculateS256CodeChallenge(parsed.codeVerifier);
    const handoffCandidates = createHmacLookupCandidates(
      config.masterKeyring,
      "handoff-lookup",
      parsed.code,
    );
    const stateCandidates = createHmacLookupCandidates(
      config.masterKeyring,
      "state-lookup",
      parsed.state,
    );
    const transaction = await repository.prepareBootstrap({
      handoffDigestCandidates: handoffCandidates.map(
        (candidate) => candidate.digest,
      ),
      stateDigestCandidates: stateCandidates.map((candidate) => candidate.digest),
      pkceChallenge: challenge,
      callbackOrigin: config.appOrigin,
      callbackPath: MOBILE_AUTH_PATHS.callback,
    });
    if (!transaction) {
      return rejectBootstrap(
        parsed,
        bootstrapFailure("mobile_auth_expired", 401),
      );
    }

    if (
      transaction.contractVersion !== MOBILE_AUTH_MESSAGE_VERSION ||
      transaction.callbackOrigin !== config.appOrigin ||
      transaction.callbackPath !== MOBILE_AUTH_PATHS.callback ||
      !constantTimeEqual(transaction.pkceChallenge, challenge)
    ) {
      return rejectBootstrap(
        parsed,
        bootstrapFailure("mobile_auth_invalid_request", 400),
        transaction.traceId,
      );
    }

    const handoffExpiry = parseEpochSeconds(transaction.handoffExpiresAt);
    if (!handoffExpiry || handoffExpiry <= Math.floor(now() / 1_000)) {
      return rejectBootstrap(
        parsed,
        bootstrapFailure("mobile_auth_expired", 401),
        transaction.traceId,
      );
    }

    const session = openSessionEnvelope(
      config.masterKeyring,
      transaction.sessionEnvelope,
      handoffExpiry,
      makeSessionContext(transaction, config),
    );
    try {
      const verified = await transferVerifier.verifyForBootstrap(session, {
        userId: transaction.verifiedUserId,
        sessionId: transaction.sourceSessionId,
      });
      if (!verified) {
        await repository.terminateTransaction(
          transaction.transactionId,
          transaction.rowVersion,
          "revoked",
          "mobile_auth_session_invalid",
        );
        return rejectBootstrap(
          parsed,
          bootstrapFailure("mobile_auth_session_invalid", 401),
          transaction.traceId,
        );
      }

      const document = renderMobileAuthBootstrapSuccessDocument({
        state: parsed.state,
        returnTo: transaction.returnTo,
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        supabaseUrl: config.supabaseOrigin,
      });
      const consumed = await repository.consumeTransaction({
        transactionId: transaction.transactionId,
        expectedRowVersion: transaction.rowVersion,
        handoffDigest: transaction.handoffDigest,
        stateDigest: transaction.stateDigest,
        pkceChallenge: transaction.pkceChallenge,
        callbackOrigin: config.appOrigin,
        callbackPath: MOBILE_AUTH_PATHS.callback,
        verifiedUserId: transaction.verifiedUserId,
        sourceSessionId: transaction.sourceSessionId,
      });
      if (!consumed) {
        return rejectBootstrap(
          parsed,
          bootstrapFailure("mobile_auth_replayed", 409),
          transaction.traceId,
        );
      }

      await recordAuditSafely(repository, {
        traceId: transaction.traceId,
        eventType: "bootstrap_accepted",
        contractVersion: transaction.contractVersion,
        environment: config.environment,
      });
      return documentResponse(document);
    } finally {
      session.accessToken = "";
      session.refreshToken = "";
    }
  }

  async function handleCleanup(
    request: Request,
    route: ResolvedMobileAuthRoute,
  ): Promise<Response> {
    if (!queryMustBeEmpty(route)) {
      return recoveryResponse(400);
    }

    const expected = `Bearer ${config.cronSecret}`;
    const authorization = request.headers.get("authorization") ?? "";
    if (!constantTimeEqual(expected, authorization)) {
      return recoveryResponse(401);
    }

    const totals = {
      expiredTransactions: 0,
      deletedTransactions: 0,
      deletedRateLimits: 0,
      deletedAuditEvents: 0,
    };
    let batches = 0;
    let drained = false;
    const deadline = Date.now() + CLEANUP_MAX_DURATION_MILLISECONDS;

    for (let index = 0; index < CLEANUP_MAX_BATCHES; index += 1) {
      const result = await cleanupWithinDeadline(repository, deadline);
      if (!result) {
        break;
      }
      batches += 1;
      totals.expiredTransactions += result.expiredTransactions;
      totals.deletedTransactions += result.deletedTransactions;
      totals.deletedRateLimits += result.deletedRateLimits;
      totals.deletedAuditEvents += result.deletedAuditEvents;

      const saturated =
        result.expiredTransactions >= CLEANUP_BATCH_SIZE ||
        result.deletedTransactions >= CLEANUP_BATCH_SIZE ||
        result.deletedRateLimits >= CLEANUP_BATCH_SIZE ||
        result.deletedAuditEvents >= CLEANUP_BATCH_SIZE;
      if (!saturated) {
        drained = true;
        break;
      }
    }

    return new Response(JSON.stringify({ ok: drained, batches, drained, ...totals }), {
      status: drained ? 200 : 503,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "Content-Type": "application/json; charset=utf-8",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  return async (request: Request): Promise<Response> => {
    let bootstrapState = ZERO_STATE;
    let route: ResolvedMobileAuthRoute;
    try {
      route = resolveMobileAuthRoute(request.url);
    } catch {
      return recoveryResponse(400);
    }

    if (request.method !== METHOD_BY_ACTION[route.action]) {
      return methodFailure(route.action);
    }

    if (route.publicUrl.origin !== config.appOrigin) {
      return recoveryResponse(400);
    }

    try {
      switch (route.action) {
        case "start":
          return await handleStart(request, route);
        case "provider-callback":
          return await handleProviderCallback(request, route);
        case "complete":
          return await handleComplete(request, route);
        case "callback":
          return await handleCallback(route);
        case "bootstrap":
          return await handleBootstrap(request, route, (state) => {
            bootstrapState = state;
          });
        case "cleanup":
          return await handleCleanup(request, route);
      }
    } catch (error) {
      const invalidRequest = isInvalidRequestFailure(error);
      if (route.action === "bootstrap") {
        return bootstrapFailureResponse(
          config,
          bootstrapState,
          invalidRequest
            ? bootstrapFailure("mobile_auth_invalid_request", 400)
            : bootstrapFailure("mobile_auth_service_unavailable", 503, "later"),
        );
      }

      return recoveryResponse(invalidRequest ? 400 : 503, {
        "Set-Cookie": serializeExpiredMobileAuthCookie(),
      });
    }
  };
}
