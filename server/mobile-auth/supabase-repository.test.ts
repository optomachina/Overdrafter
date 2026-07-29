import { describe, expect, it, vi } from "vitest";
import { createSupabaseMobileAuthRepository } from "./supabase-repository";

function rpcClient(responses: unknown[]) {
  const rpc = vi.fn();
  for (const response of responses) {
    rpc.mockResolvedValueOnce({ data: response, error: null });
  }

  return { client: { rpc }, rpc };
}

describe("Supabase mobile authentication repository", () => {
  it("passes only digests and ciphertext into transaction creation", async () => {
    const fixture = rpcClient([{ created: true }]);
    const repository = createSupabaseMobileAuthRepository("https://example.supabase.co", "secret", {
      createRpcClient: () => fixture.client,
    });

    await expect(
      repository.createTransaction({
        transactionId: "103cbe73-c611-41d1-89df-15e8c78ffeb8",
        traceId: "bad0013c-ad61-4a50-a717-4059013d232f",
        contractVersion: 1,
        cryptoKeyVersion: 2,
        stateDigest: "state-digest",
        stateEnvelope: "sealed-state",
        pkceChallenge: "pkce-challenge",
        browserBindingDigest: "browser-digest",
        csrfDigest: "csrf-digest",
        storageNamespace: "storage-namespace",
        providerCallbackPath: "/auth/mobile/provider-callback",
        callbackOrigin: "https://app.example.com",
        callbackPath: "/auth/mobile/callback",
        returnTo: "/quotes",
      }),
    ).resolves.toBe(true);

    expect(fixture.rpc).toHaveBeenCalledWith(
      "api_mobile_auth_create_transaction",
      expect.objectContaining({
        p_state_digest: "state-digest",
        p_state_envelope: "sealed-state",
        p_browser_binding_digest: "browser-digest",
        p_csrf_digest: "csrf-digest",
      }),
    );
    const serializedArguments = JSON.stringify(fixture.rpc.mock.calls);
    expect(serializedArguments).not.toContain("access-token");
    expect(serializedArguments).not.toContain("refresh-token");
  });

  it("tries retained-key digest candidates without disclosing misses", async () => {
    const fixture = rpcClient([
      {
        found: true,
        transactionId: "103cbe73-c611-41d1-89df-15e8c78ffeb8",
        traceId: "bad0013c-ad61-4a50-a717-4059013d232f",
        rowVersion: 1,
        contractVersion: 1,
        cryptoKeyVersion: 1,
        browserBindingDigest: "old-digest",
        stateEnvelope: "sealed-state",
        codeChallenge: "challenge",
        codeChallengeMethod: "S256",
        csrfDigest: "csrf-digest",
        ceremonyStorageKey: "storage-key",
        providerCallbackPath: "/auth/mobile/provider-callback",
        callbackOrigin: "https://app.example.com",
        callbackPath: "/auth/mobile/callback",
        returnTo: "/quotes",
        browserExpiresAt: "2026-07-29T08:00:00Z",
      },
    ]);
    const repository = createSupabaseMobileAuthRepository("https://example.supabase.co", "secret", {
      createRpcClient: () => fixture.client,
    });

    const transaction = await repository.findBrowserTransaction(
      "103cbe73-c611-41d1-89df-15e8c78ffeb8",
      ["new-digest", "old-digest"],
    );

    expect(transaction?.browserBindingDigest).toBe("old-digest");
    expect(fixture.rpc).toHaveBeenCalledOnce();
    expect(fixture.rpc).toHaveBeenCalledWith(
      "api_mobile_auth_get_browser_transaction",
      {
        p_transaction_id: "103cbe73-c611-41d1-89df-15e8c78ffeb8",
        p_browser_binding_digests: ["new-digest", "old-digest"],
      },
    );
  });

  it("returns exactly one successful prepare candidate for atomic consumption", async () => {
    const fixture = rpcClient([
      {
        found: true,
        transactionId: "103cbe73-c611-41d1-89df-15e8c78ffeb8",
        traceId: "bad0013c-ad61-4a50-a717-4059013d232f",
        rowVersion: 2,
        contractVersion: 1,
        cryptoKeyVersion: 1,
        handoffDigest: "new-handoff",
        stateDigest: "old-state",
        sessionEnvelope: "sealed-session",
        verifiedUserId: "2142e862-3bbd-4f30-829a-13f4e4362c55",
        sourceSessionId: "d336e2f8-d655-4f8f-bdd3-c9819c47dd41",
        codeChallenge: "challenge",
        callbackOrigin: "https://app.example.com",
        callbackPath: "/auth/mobile/callback",
        returnTo: "/quotes",
        handoffExpiresAt: "2026-07-29T08:00:00Z",
      },
    ]);
    const repository = createSupabaseMobileAuthRepository("https://example.supabase.co", "secret", {
      createRpcClient: () => fixture.client,
    });

    const prepared = await repository.prepareBootstrap({
      handoffDigestCandidates: ["new-handoff"],
      stateDigestCandidates: ["new-state", "old-state"],
      pkceChallenge: "challenge",
      callbackOrigin: "https://app.example.com",
      callbackPath: "/auth/mobile/callback",
    });

    expect(prepared).toEqual(
      expect.objectContaining({
        handoffDigest: "new-handoff",
        stateDigest: "old-state",
        sessionEnvelope: "sealed-session",
      }),
    );
    expect(fixture.rpc).toHaveBeenCalledOnce();
    expect(fixture.rpc).toHaveBeenCalledWith(
      "api_mobile_auth_prepare_bootstrap",
      {
        p_handoff_digests: ["new-handoff"],
        p_state_digests: ["new-state", "old-state"],
        p_code_challenge: "challenge",
        p_callback_origin: "https://app.example.com",
        p_callback_path: "/auth/mobile/callback",
      },
    );
  });

  it("keeps every state-transition and cleanup RPC mapping aligned", async () => {
    const fixture = rpcClient([
      { claimed: true, rowVersion: 2 },
      { completed: true },
      { consumed: true },
      { terminated: true },
      101,
      {
        expiredTransactions: 1,
        prunedTransactions: 2,
        prunedRateLimitCounters: 3,
        prunedAuditEvents: 4,
      },
    ]);
    const repository = createSupabaseMobileAuthRepository(
      "https://example.supabase.co",
      "secret",
      {
        createRpcClient: () => fixture.client,
      },
    );
    const transactionId = "103cbe73-c611-41d1-89df-15e8c78ffeb8";
    const verifiedUserId = "2142e862-3bbd-4f30-829a-13f4e4362c55";
    const sourceSessionId = "d336e2f8-d655-4f8f-bdd3-c9819c47dd41";

    await expect(
      repository.claimCompletion({
        transactionId,
        expectedRowVersion: 1,
        browserBindingDigest: "browser-digest",
        csrfDigest: "csrf-digest",
        cryptoKeyVersion: 2,
      }),
    ).resolves.toBe(2);
    await expect(
      repository.completeTransaction({
        transactionId,
        expectedRowVersion: 2,
        browserBindingDigest: "browser-digest",
        csrfDigest: "csrf-digest",
        cryptoKeyVersion: 2,
        handoffDigest: "handoff-digest",
        sessionEnvelope: "sealed-session",
        verifiedUserId,
        sourceSessionId,
        handoffExpiresAt: "2026-07-29T08:00:00Z",
      }),
    ).resolves.toBe(true);
    await expect(
      repository.consumeTransaction({
        transactionId,
        expectedRowVersion: 3,
        handoffDigest: "handoff-digest",
        stateDigest: "state-digest",
        pkceChallenge: "challenge",
        callbackOrigin: "https://app.example.com",
        callbackPath: "/auth/mobile/callback",
        verifiedUserId,
        sourceSessionId,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.terminateTransaction(
        transactionId,
        3,
        "revoked",
        "mobile_auth_session_invalid",
      ),
    ).resolves.toBe(true);
    await expect(
      repository.recordAuditEvent({
        traceId: "bad0013c-ad61-4a50-a717-4059013d232f",
        eventType: "bootstrap_rejected",
        contractVersion: 1,
        environment: "test",
        failureCode: "mobile_auth_replayed",
      }),
    ).resolves.toBeUndefined();
    await expect(repository.cleanup(250)).resolves.toEqual({
      expiredTransactions: 1,
      deletedTransactions: 2,
      deletedRateLimits: 3,
      deletedAuditEvents: 4,
    });

    expect(fixture.rpc.mock.calls).toEqual([
      [
        "api_mobile_auth_claim_completion",
        {
          p_transaction_id: transactionId,
          p_expected_version: 1,
          p_browser_binding_digest: "browser-digest",
          p_csrf_digest: "csrf-digest",
          p_crypto_key_version: 2,
        },
      ],
      [
        "api_mobile_auth_complete_transaction",
        {
          p_transaction_id: transactionId,
          p_expected_version: 2,
          p_browser_binding_digest: "browser-digest",
          p_csrf_digest: "csrf-digest",
          p_crypto_key_version: 2,
          p_handoff_digest: "handoff-digest",
          p_session_envelope: "sealed-session",
          p_verified_user_id: verifiedUserId,
          p_source_session_id: sourceSessionId,
          p_handoff_expires_at: "2026-07-29T08:00:00Z",
        },
      ],
      [
        "api_mobile_auth_consume_transaction",
        {
          p_transaction_id: transactionId,
          p_expected_version: 3,
          p_handoff_digest: "handoff-digest",
          p_state_digest: "state-digest",
          p_code_challenge: "challenge",
          p_callback_origin: "https://app.example.com",
          p_callback_path: "/auth/mobile/callback",
          p_verified_user_id: verifiedUserId,
          p_source_session_id: sourceSessionId,
        },
      ],
      [
        "api_mobile_auth_terminate_transaction",
        {
          p_transaction_id: transactionId,
          p_expected_version: 3,
          p_target_status: "revoked",
          p_failure_code: "mobile_auth_session_invalid",
        },
      ],
      [
        "api_mobile_auth_log_audit_event",
        {
          p_trace_id: "bad0013c-ad61-4a50-a717-4059013d232f",
          p_event_type: "bootstrap_rejected",
          p_contract_version: 1,
          p_environment: "test",
          p_failure_code: "mobile_auth_replayed",
          p_duration_bucket: null,
          p_app_version: null,
          p_os_version: null,
        },
      ],
      [
        "api_mobile_auth_cleanup",
        {
          p_batch_size: 250,
          p_terminal_retention_seconds: 604800,
        },
      ],
    ]);
  });

  it("fails closed when the RPC boundary reports an error", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "sensitive database detail" },
    });
    const repository = createSupabaseMobileAuthRepository("https://example.supabase.co", "secret", {
      createRpcClient: () => ({ rpc }),
    });

    await expect(
      repository.takeRateLimit({
        scope: "start_ip",
        keyVersion: 1,
        keyDigest: "digest",
        windowSeconds: 600,
        limit: 20,
      }),
    ).rejects.toThrow("persistence boundary is unavailable");
  });
});
