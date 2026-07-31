export interface CreateMobileAuthTransaction {
  transactionId: string;
  traceId: string;
  contractVersion: number;
  stateDigest: string;
  stateEnvelope: string;
  cryptoKeyVersion: number;
  pkceChallenge: string;
  storageNamespace: string;
  providerCallbackPath: string;
  callbackOrigin: string;
  callbackPath: string;
  returnTo: string;
  browserBindingDigest: string;
  csrfDigest: string;
}

export interface BrowserMobileAuthTransaction {
  transactionId: string;
  traceId: string;
  rowVersion: number;
  contractVersion: number;
  stateEnvelope: string;
  cryptoKeyVersion: number;
  pkceChallenge: string;
  pkceMethod: "S256";
  storageNamespace: string;
  providerCallbackPath: string;
  callbackOrigin: string;
  callbackPath: string;
  returnTo: string;
  browserBindingDigest: string;
  csrfDigest: string;
  browserExpiresAt: string;
}

export interface CompleteMobileAuthTransaction {
  transactionId: string;
  expectedRowVersion: number;
  browserBindingDigest: string;
  csrfDigest: string;
  cryptoKeyVersion: number;
  handoffDigest: string;
  sessionEnvelope: string;
  verifiedUserId: string;
  sourceSessionId: string;
  handoffExpiresAt: string;
}

export interface ClaimMobileAuthCompletion {
  transactionId: string;
  expectedRowVersion: number;
  browserBindingDigest: string;
  csrfDigest: string;
  cryptoKeyVersion: number;
}

export interface PreparedMobileAuthBootstrap {
  transactionId: string;
  traceId: string;
  rowVersion: number;
  contractVersion: number;
  stateDigest: string;
  handoffDigest: string;
  sessionEnvelope: string;
  cryptoKeyVersion: number;
  verifiedUserId: string;
  sourceSessionId: string;
  pkceChallenge: string;
  callbackOrigin: string;
  callbackPath: string;
  returnTo: string;
  handoffExpiresAt: string;
}

export interface PrepareMobileAuthBootstrap {
  handoffDigestCandidates: string[];
  stateDigestCandidates: string[];
  pkceChallenge: string;
  callbackOrigin: string;
  callbackPath: string;
}

export interface ConsumeMobileAuthTransaction {
  transactionId: string;
  expectedRowVersion: number;
  stateDigest: string;
  handoffDigest: string;
  pkceChallenge: string;
  callbackOrigin: string;
  callbackPath: string;
  verifiedUserId: string;
  sourceSessionId: string;
}

export type MobileAuthTerminalStatus =
  | "failed"
  | "cancelled"
  | "revoked";

export interface MobileAuthRateLimitInput {
  scope: "start_ip" | "bootstrap_ip" | "bootstrap_handoff";
  keyVersion: number;
  keyDigest: string;
  windowSeconds: number;
  limit: number;
}

export interface MobileAuthRateLimitDecision {
  allowed: boolean;
  count: number;
  retryAfterSeconds: number;
}

export type MobileAuthAuditEventType =
  | "start_accepted"
  | "start_rejected"
  | "browser_auth_completed"
  | "browser_auth_failed"
  | "handoff_created"
  | "bootstrap_accepted"
  | "bootstrap_rejected"
  | "replay_detected"
  | "session_restoration_succeeded"
  | "session_restoration_failed"
  | "logout_requested"
  | "logout_completed";

export interface MobileAuthAuditEvent {
  traceId: string;
  eventType: MobileAuthAuditEventType;
  contractVersion: number;
  environment: string;
  failureCode?: string;
  durationBucket?: string;
  appVersion?: string;
  osVersion?: string;
}

export interface MobileAuthCleanupResult {
  expiredTransactions: number;
  deletedTransactions: number;
  deletedRateLimits: number;
  deletedAuditEvents: number;
}

/**
 * Credential-adjacent persistence surface. Implementations may only accept
 * digests and authenticated ciphertext, never plaintext handoff or session
 * credentials.
 */
export interface MobileAuthRepository {
  createTransaction: (input: CreateMobileAuthTransaction) => Promise<boolean>;
  findBrowserTransaction: (
    transactionId: string,
    browserBindingDigestCandidates: string[],
  ) => Promise<BrowserMobileAuthTransaction | null>;
  claimCompletion: (input: ClaimMobileAuthCompletion) => Promise<number | null>;
  completeTransaction: (input: CompleteMobileAuthTransaction) => Promise<boolean>;
  prepareBootstrap: (
    input: PrepareMobileAuthBootstrap,
  ) => Promise<PreparedMobileAuthBootstrap | null>;
  consumeTransaction: (input: ConsumeMobileAuthTransaction) => Promise<boolean>;
  terminateTransaction: (
    transactionId: string,
    expectedRowVersion: number,
    status: MobileAuthTerminalStatus,
    failureCode: string,
  ) => Promise<boolean>;
  takeRateLimit: (input: MobileAuthRateLimitInput) => Promise<MobileAuthRateLimitDecision>;
  recordAuditEvent: (event: MobileAuthAuditEvent) => Promise<void>;
  cleanup: (batchSize: number) => Promise<MobileAuthCleanupResult>;
}
