import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  calculateS256CodeChallenge,
  createMobileAuthCodeVerifier,
} from "./crypto";
import { MOBILE_AUTH_BOOTSTRAP_HEADER } from "./contract";
import { createMobileAuthHandler } from "./handler";
import type {
  BrowserMobileAuthTransaction,
  ClaimMobileAuthCompletion,
  CompleteMobileAuthTransaction,
  ConsumeMobileAuthTransaction,
  CreateMobileAuthTransaction,
  MobileAuthAuditEvent,
  MobileAuthCleanupResult,
  MobileAuthRateLimitDecision,
  MobileAuthRepository,
  MobileAuthTerminalStatus,
  PrepareMobileAuthBootstrap,
  PreparedMobileAuthBootstrap,
} from "./repository";
import type { MobileAuthRuntimeConfig } from "./runtime-config";
import type {
  TransferSessionVerifier,
  VerifiedTransferSession,
} from "./supabase-transfer";

const APP_ORIGIN = "https://app.example.com";
const USER_ID = "0190f3d0-7f34-7e19-8da9-1132a848e042";
const SESSION_ID = "0190f3d0-81d4-7f5f-9a31-792c0ef7f8b8";

interface StoredTransaction extends CreateMobileAuthTransaction {
  status:
    | "authenticating"
    | "verifying"
    | "completed"
    | "consumed"
    | MobileAuthTerminalStatus;
  rowVersion: number;
  handoffDigest?: string;
  sessionEnvelope?: string;
  verifiedUserId?: string;
  sourceSessionId?: string;
  handoffExpiresAt?: string;
}

class MemoryRepository implements MobileAuthRepository {
  transaction: StoredTransaction | null = null;
  audits: MobileAuthAuditEvent[] = [];
  consumeCount = 0;
  claimCount = 0;
  rateDecision: MobileAuthRateLimitDecision = {
    allowed: true,
    count: 1,
    retryAfterSeconds: 600,
  };

  async createTransaction(input: CreateMobileAuthTransaction) {
    this.transaction = {
      ...input,
      status: "authenticating",
      rowVersion: 1,
    };
    return true;
  }

  async findBrowserTransaction(
    transactionId: string,
    browserBindingDigestCandidates: string[],
  ): Promise<BrowserMobileAuthTransaction | null> {
    const transaction = this.transaction;
    if (
      !transaction ||
      transaction.status !== "authenticating" ||
      transaction.transactionId !== transactionId ||
      !browserBindingDigestCandidates.includes(transaction.browserBindingDigest)
    ) {
      return null;
    }

    return {
      transactionId: transaction.transactionId,
      traceId: transaction.traceId,
      rowVersion: transaction.rowVersion,
      contractVersion: transaction.contractVersion,
      stateEnvelope: transaction.stateEnvelope,
      cryptoKeyVersion: transaction.cryptoKeyVersion,
      pkceChallenge: transaction.pkceChallenge,
      pkceMethod: "S256",
      storageNamespace: transaction.storageNamespace,
      providerCallbackPath: transaction.providerCallbackPath,
      callbackOrigin: transaction.callbackOrigin,
      callbackPath: transaction.callbackPath,
      returnTo: transaction.returnTo,
      browserBindingDigest: transaction.browserBindingDigest,
      csrfDigest: transaction.csrfDigest,
      browserExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
  }

  async completeTransaction(input: CompleteMobileAuthTransaction) {
    const transaction = this.transaction;
    if (
      !transaction ||
      transaction.status !== "verifying" ||
      transaction.rowVersion !== input.expectedRowVersion ||
      transaction.browserBindingDigest !== input.browserBindingDigest ||
      transaction.csrfDigest !== input.csrfDigest ||
      transaction.cryptoKeyVersion !== input.cryptoKeyVersion
    ) {
      return false;
    }

    Object.assign(transaction, {
      status: "completed",
      rowVersion: transaction.rowVersion + 1,
      handoffDigest: input.handoffDigest,
      sessionEnvelope: input.sessionEnvelope,
      verifiedUserId: input.verifiedUserId,
      sourceSessionId: input.sourceSessionId,
      handoffExpiresAt: input.handoffExpiresAt,
    });
    return true;
  }

  async claimCompletion(input: ClaimMobileAuthCompletion) {
    const transaction = this.transaction;
    if (
      !transaction ||
      transaction.status !== "authenticating" ||
      transaction.rowVersion !== input.expectedRowVersion ||
      transaction.browserBindingDigest !== input.browserBindingDigest ||
      transaction.csrfDigest !== input.csrfDigest ||
      transaction.cryptoKeyVersion !== input.cryptoKeyVersion
    ) {
      return null;
    }

    transaction.status = "verifying";
    transaction.rowVersion += 1;
    this.claimCount += 1;
    return transaction.rowVersion;
  }

  async prepareBootstrap(
    input: PrepareMobileAuthBootstrap,
  ): Promise<PreparedMobileAuthBootstrap | null> {
    const transaction = this.transaction;
    if (
      !transaction ||
      transaction.status !== "completed" ||
      !transaction.handoffDigest ||
      !transaction.sessionEnvelope ||
      !transaction.verifiedUserId ||
      !transaction.sourceSessionId ||
      !transaction.handoffExpiresAt ||
      !input.handoffDigestCandidates.includes(transaction.handoffDigest) ||
      !input.stateDigestCandidates.includes(transaction.stateDigest) ||
      input.pkceChallenge !== transaction.pkceChallenge ||
      input.callbackOrigin !== transaction.callbackOrigin ||
      input.callbackPath !== transaction.callbackPath
    ) {
      return null;
    }

    return {
      transactionId: transaction.transactionId,
      traceId: transaction.traceId,
      rowVersion: transaction.rowVersion,
      contractVersion: transaction.contractVersion,
      stateDigest: transaction.stateDigest,
      handoffDigest: transaction.handoffDigest,
      sessionEnvelope: transaction.sessionEnvelope,
      cryptoKeyVersion: transaction.cryptoKeyVersion,
      verifiedUserId: transaction.verifiedUserId,
      sourceSessionId: transaction.sourceSessionId,
      pkceChallenge: transaction.pkceChallenge,
      callbackOrigin: transaction.callbackOrigin,
      callbackPath: transaction.callbackPath,
      returnTo: transaction.returnTo,
      handoffExpiresAt: transaction.handoffExpiresAt,
    };
  }

  async consumeTransaction(input: ConsumeMobileAuthTransaction) {
    const transaction = this.transaction;
    if (
      !transaction ||
      transaction.status !== "completed" ||
      transaction.rowVersion !== input.expectedRowVersion ||
      transaction.handoffDigest !== input.handoffDigest ||
      transaction.stateDigest !== input.stateDigest
    ) {
      return false;
    }

    transaction.status = "consumed";
    transaction.rowVersion += 1;
    transaction.sessionEnvelope = undefined;
    this.consumeCount += 1;
    return true;
  }

  async terminateTransaction(
    transactionId: string,
    expectedRowVersion: number,
    status: MobileAuthTerminalStatus,
  ) {
    const transaction = this.transaction;
    if (
      !transaction ||
      transaction.transactionId !== transactionId ||
      transaction.rowVersion !== expectedRowVersion
    ) {
      return false;
    }

    transaction.status = status;
    transaction.rowVersion += 1;
    transaction.sessionEnvelope = undefined;
    return true;
  }

  async takeRateLimit() {
    return this.rateDecision;
  }

  async recordAuditEvent(event: MobileAuthAuditEvent) {
    this.audits.push(event);
  }

  async cleanup(): Promise<MobileAuthCleanupResult> {
    return {
      expiredTransactions: 1,
      deletedTransactions: 2,
      deletedRateLimits: 3,
      deletedAuditEvents: 4,
    };
  }
}

function runtimeConfig(): MobileAuthRuntimeConfig {
  return {
    appOrigin: APP_ORIGIN,
    callbackUrl: `${APP_ORIGIN}/auth/mobile/callback`,
    providerCallbackUrl: `${APP_ORIGIN}/auth/mobile/provider-callback`,
    supabaseOrigin: "https://project.supabase.co",
    supabasePublishableKey: "publishable-key",
    supabaseServiceRoleKey: "service-role-key",
    masterKeyring: {
      currentVersion: 2,
      keys: [
        { version: 1, key: randomBytes(32) },
        { version: 2, key: randomBytes(32) },
      ],
    },
    environment: "test",
    cronSecret: randomBytes(32).toString("base64url"),
  };
}

function verifier(overrides: Partial<TransferSessionVerifier> = {}): TransferSessionVerifier {
  return {
    verifyAndRotate: vi.fn(async (): Promise<VerifiedTransferSession> => ({
      accessToken: "rotated.access.token",
      refreshToken: "rotated-refresh-token",
      userId: USER_ID,
      sessionId: SESSION_ID,
    })),
    verifyForBootstrap: vi.fn(async () => true),
    ...overrides,
  };
}

function readInertConfig(body: string, elementId: string): Record<string, unknown> {
  const expression = new RegExp(
    `<script id="${elementId}"[^>]*>([\\s\\S]*?)<\\/script>`,
  );
  const match = expression.exec(body);
  if (!match) {
    throw new Error("Expected inert configuration.");
  }

  return JSON.parse(match[1]) as Record<string, unknown>;
}

function cookieHeader(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error("Expected mobile authentication cookie.");
  }

  return setCookie.split(";", 1)[0];
}

async function startAndComplete(
  repository: MemoryRepository,
  config: MobileAuthRuntimeConfig,
  transferVerifier = verifier(),
) {
  const handler = createMobileAuthHandler({
    config,
    repository,
    transferVerifier,
  });
  const codeVerifier = createMobileAuthCodeVerifier();
  const state = randomBytes(32).toString("base64url");
  const startUrl = new URL("/auth/mobile/start", APP_ORIGIN);
  startUrl.search = new URLSearchParams({
    v: "1",
    state,
    code_challenge: calculateS256CodeChallenge(codeVerifier),
    code_challenge_method: "S256",
    return_to: "/quotes",
  }).toString();
  const startResponse = await handler(
    new Request(startUrl, {
      headers: { "x-vercel-forwarded-for": "203.0.113.5" },
    }),
  );
  const startBody = await startResponse.text();
  expect(startResponse.status).toBe(200);
  const configPayload = readInertConfig(
    startBody,
    "overdrafter-mobile-auth-config",
  );
  const cookie = cookieHeader(startResponse);
  const completeResponse = await handler(
    new Request(`${APP_ORIGIN}/auth/mobile/complete`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        v: "1",
        csrf: String(configPayload.csrf),
        access_token: "original.access.token",
        refresh_token: "original-refresh-token",
      }),
    }),
  );

  return {
    handler,
    codeVerifier,
    state,
    startResponse,
    startBody,
    cookie,
    completeResponse,
  };
}

describe("mobile authentication HTTP bridge", () => {
  it("rate-limits ceremony starts before creating a transaction", async () => {
    const repository = new MemoryRepository();
    repository.rateDecision = {
      allowed: false,
      count: 11,
      retryAfterSeconds: 42,
    };
    const handler = createMobileAuthHandler({
      config: runtimeConfig(),
      repository,
      transferVerifier: verifier(),
    });
    const codeVerifier = createMobileAuthCodeVerifier();
    const startUrl = new URL("/auth/mobile/start", APP_ORIGIN);
    startUrl.search = new URLSearchParams({
      v: "1",
      state: randomBytes(32).toString("base64url"),
      code_challenge: calculateS256CodeChallenge(codeVerifier),
      code_challenge_method: "S256",
    }).toString();

    const response = await handler(
      new Request(startUrl, {
        headers: { "x-vercel-forwarded-for": "203.0.113.5" },
      }),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
    expect(repository.transaction).toBeNull();
    expect(repository.audits).toContainEqual(
      expect.objectContaining({
        eventType: "start_rejected",
        failureCode: "mobile_auth_rate_limited",
      }),
    );
  });

  it("transfers one fresh session without putting credentials in a URL", async () => {
    const repository = new MemoryRepository();
    const config = runtimeConfig();
    let decryptedSession:
      | { accessToken: string; refreshToken: string }
      | undefined;
    const transferVerifier = verifier({
      verifyForBootstrap: vi.fn(async (session) => {
        decryptedSession = session;
        return true;
      }),
    });
    const flow = await startAndComplete(repository, config, transferVerifier);

    expect(flow.startResponse.status).toBe(200);
    expect(flow.startResponse.headers.get("cache-control")).toContain("no-store");
    expect(flow.startBody).toContain("/assets/mobile-auth.js");
    expect(flow.startBody).not.toContain(flow.state);
    expect(flow.completeResponse.status).toBe(303);

    const callback = new URL(flow.completeResponse.headers.get("location") ?? "");
    const callbackFields = new URLSearchParams(callback.hash.slice(1));
    expect(callback.origin).toBe(APP_ORIGIN);
    expect(callback.pathname).toBe("/auth/mobile/callback");
    expect(callback.search).toBe("");
    expect(callbackFields.get("state")).toBe(flow.state);
    expect(callback.toString()).not.toContain("rotated");

    const missingNativeHeaderBootstrap = await flow.handler(
      new Request(`${APP_ORIGIN}/auth/mobile/bootstrap`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "x-vercel-forwarded-for": "203.0.113.5",
        },
        body: new URLSearchParams({
          v: "1",
          code: callbackFields.get("code") ?? "",
          state: flow.state,
          code_verifier: flow.codeVerifier,
        }),
      }),
    );
    const missingNativeHeaderBody = await missingNativeHeaderBootstrap.text();

    expect(missingNativeHeaderBootstrap.status).toBe(403);
    expect(missingNativeHeaderBody).not.toContain("<script");
    expect(missingNativeHeaderBody).not.toContain("rotated-refresh-token");
    expect(repository.consumeCount).toBe(0);

    const crossSiteBootstrap = await flow.handler(
      new Request(`${APP_ORIGIN}/auth/mobile/bootstrap`, {
        method: "POST",
        headers: {
          [MOBILE_AUTH_BOOTSTRAP_HEADER.name]:
            MOBILE_AUTH_BOOTSTRAP_HEADER.value,
          "Content-Type": "application/x-www-form-urlencoded",
          Origin: "https://attacker.example",
          "Sec-Fetch-Site": "cross-site",
          "x-vercel-forwarded-for": "203.0.113.5",
        },
        body: new URLSearchParams({
          v: "1",
          code: callbackFields.get("code") ?? "",
          state: flow.state,
          code_verifier: flow.codeVerifier,
        }),
      }),
    );
    const crossSiteBody = await crossSiteBootstrap.text();

    expect(crossSiteBootstrap.status).toBe(403);
    expect(crossSiteBody).not.toContain("<script");
    expect(crossSiteBody).not.toContain("rotated-refresh-token");
    expect(repository.consumeCount).toBe(0);

    const bootstrapResponse = await flow.handler(
      new Request(`${APP_ORIGIN}/auth/mobile/bootstrap`, {
        method: "POST",
        headers: {
          [MOBILE_AUTH_BOOTSTRAP_HEADER.name]:
            MOBILE_AUTH_BOOTSTRAP_HEADER.value,
          "Content-Type": "application/x-www-form-urlencoded",
          "x-vercel-forwarded-for": "203.0.113.5",
        },
        body: new URLSearchParams({
          v: "1",
          code: callbackFields.get("code") ?? "",
          state: flow.state,
          code_verifier: flow.codeVerifier,
        }),
      }),
    );
    const bootstrapBody = await bootstrapResponse.text();

    expect(bootstrapResponse.status).toBe(200);
    expect(bootstrapResponse.headers.get("cache-control")).toContain("no-store");
    expect(bootstrapResponse.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(bootstrapBody).toContain("/assets/mobile-bootstrap.js");
    expect(repository.consumeCount).toBe(1);
    expect(repository.transaction?.sessionEnvelope).toBeUndefined();
    expect(decryptedSession).toEqual({
      accessToken: "",
      refreshToken: "",
    });

    const replayResponse = await flow.handler(
      new Request(`${APP_ORIGIN}/auth/mobile/bootstrap`, {
        method: "POST",
        headers: {
          [MOBILE_AUTH_BOOTSTRAP_HEADER.name]:
            MOBILE_AUTH_BOOTSTRAP_HEADER.value,
          "Content-Type": "application/x-www-form-urlencoded",
          "x-vercel-forwarded-for": "203.0.113.5",
        },
        body: new URLSearchParams({
          v: "1",
          code: callbackFields.get("code") ?? "",
          state: flow.state,
          code_verifier: flow.codeVerifier,
        }),
      }),
    );
    expect(replayResponse.status).not.toBe(200);
    expect(await replayResponse.text()).not.toContain("rotated-refresh-token");
  });

  it.each([
    {
      label: "bootstrap IP",
      ipAllowed: false,
      handoffAllowed: true,
      retryAfterSeconds: 37,
    },
    {
      label: "handoff",
      ipAllowed: true,
      handoffAllowed: false,
      retryAfterSeconds: 53,
    },
  ])(
    "rate-limits $label redemption before session verification",
    async ({ ipAllowed, handoffAllowed, retryAfterSeconds }) => {
      const repository = new MemoryRepository();
      const config = runtimeConfig();
      const transferVerifier = verifier();
      const flow = await startAndComplete(repository, config, transferVerifier);
      const callback = new URL(flow.completeResponse.headers.get("location") ?? "");
      const fields = new URLSearchParams(callback.hash.slice(1));
      const takeRateLimit = vi.spyOn(repository, "takeRateLimit");
      takeRateLimit
        .mockResolvedValueOnce({
          allowed: ipAllowed,
          count: ipAllowed ? 1 : 11,
          retryAfterSeconds: ipAllowed ? 0 : retryAfterSeconds,
        })
        .mockResolvedValueOnce({
          allowed: handoffAllowed,
          count: handoffAllowed ? 1 : 11,
          retryAfterSeconds: handoffAllowed ? 0 : retryAfterSeconds,
        });

      const response = await flow.handler(
        new Request(`${APP_ORIGIN}/auth/mobile/bootstrap`, {
          method: "POST",
          headers: {
            [MOBILE_AUTH_BOOTSTRAP_HEADER.name]:
              MOBILE_AUTH_BOOTSTRAP_HEADER.value,
            "Content-Type": "application/x-www-form-urlencoded",
            "x-vercel-forwarded-for": "203.0.113.5",
          },
          body: new URLSearchParams({
            v: "1",
            code: fields.get("code") ?? "",
            state: flow.state,
            code_verifier: flow.codeVerifier,
          }),
        }),
      );

      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe(String(retryAfterSeconds));
      expect(transferVerifier.verifyForBootstrap).not.toHaveBeenCalled();
      expect(repository.consumeCount).toBe(0);
      expect(await response.text()).toContain("mobile_auth_rate_limited");
    },
  );

  it("binds provider callbacks to the initiating transaction", async () => {
    const repository = new MemoryRepository();
    const config = runtimeConfig();
    const handler = createMobileAuthHandler({
      config,
      repository,
      transferVerifier: verifier(),
    });
    const codeVerifier = createMobileAuthCodeVerifier();
    const state = randomBytes(32).toString("base64url");
    const startUrl = new URL("/auth/mobile/start", APP_ORIGIN);
    startUrl.search = new URLSearchParams({
      v: "1",
      state,
      code_challenge: calculateS256CodeChallenge(codeVerifier),
      code_challenge_method: "S256",
    }).toString();
    const startResponse = await handler(new Request(startUrl));
    const startConfig = readInertConfig(
      await startResponse.text(),
      "overdrafter-mobile-auth-config",
    );
    const callbackUrl = new URL(String(startConfig.providerCallbackUrl));
    const transactionId = repository.transaction?.transactionId;

    expect(startResponse.status).toBe(200);
    expect(callbackUrl.origin).toBe(APP_ORIGIN);
    expect(callbackUrl.pathname).toBe("/auth/mobile/provider-callback");
    expect(callbackUrl.searchParams.get("cb")).toBe(transactionId);
    expect([...callbackUrl.searchParams.keys()]).toEqual(["cb"]);

    const mismatchedCallback = new URL(callbackUrl);
    mismatchedCallback.searchParams.set("cb", randomUUID());
    mismatchedCallback.searchParams.set("code", "mismatched-provider-code");
    const mismatchResponse = await handler(
      new Request(mismatchedCallback, {
        headers: { Cookie: cookieHeader(startResponse) },
      }),
    );
    const mismatchBody = await mismatchResponse.text();

    expect(mismatchResponse.status).toBe(403);
    expect(mismatchResponse.headers.get("set-cookie")).toBeNull();
    expect(mismatchBody).not.toContain("<script");
    expect(repository.transaction?.status).toBe("authenticating");

    callbackUrl.searchParams.set("code", "bound-provider-code");
    const callbackResponse = await handler(
      new Request(callbackUrl, {
        headers: { Cookie: cookieHeader(startResponse) },
      }),
    );
    const callbackBody = await callbackResponse.text();
    const callbackConfig = readInertConfig(
      callbackBody,
      "overdrafter-mobile-auth-config",
    );

    expect(callbackResponse.status).toBe(200);
    expect(callbackConfig.mode).toBe("code");
    expect(callbackConfig.code).toBe("bound-provider-code");
    expect(callbackConfig.providerCallbackUrl).toBe(
      `${APP_ORIGIN}/auth/mobile/provider-callback?cb=${transactionId}`,
    );
  });

  it("rejects a wrong independent CSRF proof before session verification", async () => {
    const repository = new MemoryRepository();
    const config = runtimeConfig();
    const transferVerifier = verifier();
    const handler = createMobileAuthHandler({
      config,
      repository,
      transferVerifier,
    });
    const codeVerifier = createMobileAuthCodeVerifier();
    const state = randomBytes(32).toString("base64url");
    const start = new URL("/auth/mobile/start", APP_ORIGIN);
    start.search = new URLSearchParams({
      v: "1",
      state,
      code_challenge: calculateS256CodeChallenge(codeVerifier),
      code_challenge_method: "S256",
    }).toString();
    const startResponse = await handler(new Request(start));

    const response = await handler(
      new Request(`${APP_ORIGIN}/auth/mobile/complete`, {
        method: "POST",
        headers: {
          Cookie: cookieHeader(startResponse),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          v: "1",
          csrf: randomBytes(32).toString("base64url"),
          access_token: "sentinel-access-token",
          refresh_token: "sentinel-refresh-token",
        }),
      }),
    );

    expect(response.status).toBe(403);
    expect(transferVerifier.verifyAndRotate).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("sentinel");
  });

  it("allows only one concurrent bootstrap consumer", async () => {
    const repository = new MemoryRepository();
    const config = runtimeConfig();
    let verificationCalls = 0;
    let releaseVerification: (() => void) | null = null;
    const bothVerifying = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });
    const transferVerifier = verifier({
      verifyForBootstrap: vi.fn(async () => {
        verificationCalls += 1;
        if (verificationCalls === 2) {
          releaseVerification?.();
        }
        await bothVerifying;
        return true;
      }),
    });
    const flow = await startAndComplete(repository, config, transferVerifier);
    const callback = new URL(flow.completeResponse.headers.get("location") ?? "");
    const fields = new URLSearchParams(callback.hash.slice(1));
    const makeRequest = () =>
      new Request(`${APP_ORIGIN}/auth/mobile/bootstrap`, {
        method: "POST",
        headers: {
          [MOBILE_AUTH_BOOTSTRAP_HEADER.name]:
            MOBILE_AUTH_BOOTSTRAP_HEADER.value,
          "Content-Type": "application/x-www-form-urlencoded",
          "x-vercel-forwarded-for": "203.0.113.5",
        },
        body: new URLSearchParams({
          v: "1",
          code: fields.get("code") ?? "",
          state: flow.state,
          code_verifier: flow.codeVerifier,
        }),
      });

    const responses = await Promise.all([
      flow.handler(makeRequest()),
      flow.handler(makeRequest()),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(repository.consumeCount).toBe(1);
    const bodies = await Promise.all(responses.map((response) => response.text()));
    expect(bodies.filter((body) => body.includes("rotated-refresh-token"))).toHaveLength(1);
  });

  it("protects cleanup with the Vercel cron secret", async () => {
    const repository = new MemoryRepository();
    const cleanup = vi
      .spyOn(repository, "cleanup")
      .mockResolvedValueOnce({
        expiredTransactions: 250,
        deletedTransactions: 2,
        deletedRateLimits: 3,
        deletedAuditEvents: 4,
      })
      .mockResolvedValueOnce({
        expiredTransactions: 1,
        deletedTransactions: 0,
        deletedRateLimits: 0,
        deletedAuditEvents: 0,
      });
    const config = runtimeConfig();
    const handler = createMobileAuthHandler({
      config,
      repository,
      transferVerifier: verifier(),
    });

    const unauthorized = await handler(
      new Request(`${APP_ORIGIN}/api/mobile-auth?action=cleanup`),
    );
    expect(unauthorized.status).toBe(401);

    const authorized = await handler(
      new Request(`${APP_ORIGIN}/api/mobile-auth?action=cleanup`, {
        headers: { Authorization: `Bearer ${config.cronSecret}` },
      }),
    );
    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toEqual({
      ok: true,
      batches: 2,
      drained: true,
      expiredTransactions: 251,
      deletedTransactions: 2,
      deletedRateLimits: 3,
      deletedAuditEvents: 4,
    });
    expect(cleanup).toHaveBeenNthCalledWith(1, 250);
    expect(cleanup).toHaveBeenNthCalledWith(2, 250);
  });

  it("fails observably when cleanup reaches the forty-batch safety cap", async () => {
    const repository = new MemoryRepository();
    const cleanup = vi.spyOn(repository, "cleanup").mockResolvedValue({
      expiredTransactions: 250,
      deletedTransactions: 0,
      deletedRateLimits: 0,
      deletedAuditEvents: 0,
    });
    const config = runtimeConfig();
    const handler = createMobileAuthHandler({
      config,
      repository,
      transferVerifier: verifier(),
    });

    const response = await handler(
      new Request(`${APP_ORIGIN}/api/mobile-auth?action=cleanup`, {
        headers: { Authorization: `Bearer ${config.cronSecret}` },
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      batches: 40,
      drained: false,
      expiredTransactions: 10_000,
      deletedTransactions: 0,
      deletedRateLimits: 0,
      deletedAuditEvents: 0,
    });
    expect(cleanup).toHaveBeenCalledTimes(40);
    expect(cleanup).toHaveBeenLastCalledWith(250);
  });

  it("keeps the claimed HTTPS callback script-free when opened normally", async () => {
    const handler = createMobileAuthHandler({
      config: runtimeConfig(),
      repository: new MemoryRepository(),
      transferVerifier: verifier(),
    });
    const response = await handler(
      new Request(`${APP_ORIGIN}/auth/mobile/callback`),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body).not.toContain("<script");
    expect(body).not.toContain("location.hash");
  });

  it("classifies malformed ceremony and bootstrap input as invalid requests", async () => {
    const handler = createMobileAuthHandler({
      config: runtimeConfig(),
      repository: new MemoryRepository(),
      transferVerifier: verifier(),
    });
    const malformedStart = await handler(
      new Request(
        `${APP_ORIGIN}/auth/mobile/start?v=1&state=bad&code_challenge=bad&code_challenge_method=S256`,
      ),
    );
    const malformedBootstrap = await handler(
      new Request(`${APP_ORIGIN}/auth/mobile/bootstrap`, {
        method: "POST",
        headers: {
          [MOBILE_AUTH_BOOTSTRAP_HEADER.name]:
            MOBILE_AUTH_BOOTSTRAP_HEADER.value,
          "Content-Type": "application/x-www-form-urlencoded",
          "x-vercel-forwarded-for": "203.0.113.5",
        },
        body: new URLSearchParams({
          v: "1",
          state: "bad",
          code_verifier: "bad",
        }),
      }),
    );
    const bootstrapBody = await malformedBootstrap.text();

    expect(malformedStart.status).toBe(400);
    expect(malformedBootstrap.status).toBe(400);
    expect(bootstrapBody).toContain("mobile_auth_invalid_request");
    expect(bootstrapBody).not.toContain("mobile_auth_service_unavailable");
  });
});
