import { createHash } from "node:crypto";
import {
  fingerprintProviderDispatchEnvelope,
  isRetryableProviderDispatchDenial,
  parseProviderDispatchEnvelope,
  type ProviderDispatchDenialCode,
} from "./providerDispatchEnvelope.js";
import { ProviderDispatchAuthorizationError } from "./providerDispatchPreflight.js";
import type {
  ProviderDispatchAuthorization,
  ProviderDispatchEnvelope,
  ProviderDispatchFileRole,
} from "./providerDispatchTypes.js";
import { VendorAutomationError, type VendorName } from "./types.js";

/**
 * OVD-461 provider authorization consumer and execution seam.
 *
 * Takes one already parsed `ProviderDispatchAuthorization` (the service
 * preflight stays authoritative; no admission policy is duplicated here),
 * re-checks it for exact agreement with what the worker expects to run, and
 * only then hands one bounded execution to a provider neutral adapter. Default
 * deny: every missing, stale or mismatched input returns a denial and makes
 * zero adapter calls.
 *
 * Nothing here retries. The sole retryable outcome is the documented
 * `preflight_unavailable` denial, which is a decision for the caller's queue,
 * not for this seam. Login, challenge, block and ban outcomes are terminal and
 * surface as manual follow up. Results and logs carry stable codes only.
 *
 * Not wired into the worker; OVD-464 owns routing. The session fields mirror
 * the OVD-462 lease identity (provider, account reference, environment) without
 * importing it.
 */

export const PROVIDER_EXECUTION_ENVIRONMENTS = ["production", "staging", "development", "test"] as const;
export type ProviderExecutionEnvironment = (typeof PROVIDER_EXECUTION_ENVIRONMENTS)[number];

export type ProviderExecutionDenialCode =
  | ProviderDispatchDenialCode
  | "authorization_missing"
  | "execution_request_malformed"
  | "account_mismatch"
  | "environment_mismatch"
  | "adapter_mismatch"
  | "captured_file_mismatch";

/** Outcomes that need an operator. The seam never retries them. */
export const PROVIDER_EXECUTION_TERMINAL_OUTCOMES = ["login_required", "challenge_required", "blocked", "banned"] as const;
export type ProviderExecutionTerminalOutcome = (typeof PROVIDER_EXECUTION_TERMINAL_OUTCOMES)[number];

/** An adapter throws this to report a terminal provider condition. */
export class ProviderExecutionTerminalError extends Error {
  constructor(readonly outcome: ProviderExecutionTerminalOutcome) {
    super("Provider execution reached a terminal condition.");
    this.name = "ProviderExecutionTerminalError";
  }
}

const VENDOR_ERROR_OUTCOMES: Partial<Record<VendorAutomationError["code"], ProviderExecutionTerminalOutcome>> = {
  login_required: "login_required",
  captcha: "challenge_required",
  anti_detection_block: "blocked",
};

export function providerExecutionTerminalOutcomeForError(error: unknown): ProviderExecutionTerminalOutcome | null {
  if (error instanceof ProviderExecutionTerminalError) return error.outcome;
  if (error instanceof VendorAutomationError) return VENDOR_ERROR_OUTCOMES[error.code] ?? null;
  return null;
}

/** What the worker expects to run, taken from its own claim, never from the authorization. */
export type ProviderExecutionExpectation = {
  provider: VendorName;
  accountRef: string;
  environment: ProviderExecutionEnvironment;
  organizationId: string;
  envelope: { id: string; version: number };
  envelopeFingerprint: string;
  permitId: string;
  sessionBindingId: string;
  task: ProviderDispatchEnvelope["task"];
  scope: { fingerprint: string; requestedQuantity: number };
  rolloutRevision: number;
};

/** Session identity as reported by the lease holder (OVD-462 shape, opaque references only). */
export type ProviderExecutionSession = {
  provider: VendorName;
  accountRef: string;
  environment: ProviderExecutionEnvironment;
};

export type ProviderExecutionCapturedFile = { role: ProviderDispatchFileRole; bytes: Uint8Array };

export type ProviderExecutionRequest = {
  authorization: ProviderDispatchAuthorization | null | undefined;
  expected: ProviderExecutionExpectation;
  session: ProviderExecutionSession;
  /** Bytes captured by the caller before this call; no path crosses the seam. */
  files: readonly ProviderExecutionCapturedFile[];
  nowMs?: number;
};

export type ProviderExecutionFile = {
  readonly role: ProviderDispatchFileRole;
  readonly sha256: string;
  /** A fresh copy on every call, so an adapter cannot alter what a later reader sees. */
  bytes(): Uint8Array;
};

export type ProviderExecutionContext = Readonly<{
  provider: VendorName;
  environment: ProviderExecutionEnvironment;
  permitId: string;
  envelopeFingerprint: string;
  sessionBindingId: string;
  requestedQuantity: number;
  files: readonly ProviderExecutionFile[];
}>;

export type ProviderExecutionAdapter<T> = {
  provider: VendorName;
  execute(context: ProviderExecutionContext): Promise<T>;
};

export type ProviderExecutionResult<T> =
  | { kind: "completed"; value: T }
  | { kind: "denied"; denial: ProviderExecutionDenialCode; retryable: boolean }
  | { kind: "terminal"; outcome: ProviderExecutionTerminalOutcome; disposition: "manual_follow_up"; retryable: false }
  | { kind: "adapter_failed"; retryable: false };

export type ProviderExecutionLogEvent = {
  event: "provider_execution.denied" | "provider_execution.started" | "provider_execution.terminal" | "provider_execution.failed";
  provider: string;
  denial?: ProviderExecutionDenialCode;
  outcome?: ProviderExecutionTerminalOutcome;
};

export type ProviderExecutionLogger = (event: ProviderExecutionLogEvent) => void;

function defaultLogger(event: ProviderExecutionLogEvent): void {
  console.info(JSON.stringify({ level: "info", source: "providerExecutionSeam", ...event }));
}

/** Stable denial for a failed preflight call, so the caller can hand it to the same result type. */
export function providerExecutionDenialFromError(error: unknown): ProviderExecutionResult<never> | null {
  if (!(error instanceof ProviderDispatchAuthorizationError)) return null;
  return { kind: "denied", denial: error.denial, retryable: error.retryable };
}

const SHA256 = /^[a-f0-9]{64}$/;
const ROLES: readonly string[] = ["cad", "drawing"];

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function sameTask(a: ProviderDispatchEnvelope["task"], b: ProviderDispatchEnvelope["task"]): boolean {
  const keys: (keyof ProviderDispatchEnvelope["task"])[] = [
    "quoteRequestId",
    "quoteRunId",
    "vendorQuoteResultId",
    "quoteRequestLaneId",
    "workQueueTaskId",
  ];
  return keys.every((key) => a[key] === b[key]);
}

function requestMalformed(request: ProviderExecutionRequest): boolean {
  const { expected, session } = request;
  return (
    !expected ||
    !session ||
    !Array.isArray(request.files) ||
    !isNonEmptyString(expected.accountRef) ||
    !isNonEmptyString(expected.organizationId) ||
    !isNonEmptyString(expected.permitId) ||
    !isNonEmptyString(expected.sessionBindingId) ||
    !SHA256.test(expected.envelopeFingerprint) ||
    !PROVIDER_EXECUTION_ENVIRONMENTS.includes(expected.environment) ||
    !PROVIDER_EXECUTION_ENVIRONMENTS.includes(session.environment) ||
    !expected.envelope ||
    !expected.task ||
    !expected.scope
  );
}

/**
 * Pure authorization check. Returns the denial for the first failing boundary,
 * or the validated envelope. Order: shape, provider, account, environment,
 * envelope identity and fingerprint, permit, task and lane, organization,
 * scope, session binding, capability decision, then time.
 */
function authorizationDenial(
  request: ProviderExecutionRequest,
  nowMs: number,
): { denial: ProviderExecutionDenialCode } | { envelope: ProviderDispatchEnvelope } {
  const { authorization, expected, session } = request;
  if (!authorization) return { denial: "authorization_missing" };
  if (requestMalformed(request)) return { denial: "execution_request_malformed" };

  const parsed = parseProviderDispatchEnvelope(authorization.envelope);
  if (!parsed.ok) return { denial: parsed.denial };
  const envelope = parsed.envelope;
  let fingerprint: string;
  try {
    fingerprint = fingerprintProviderDispatchEnvelope(envelope);
  } catch {
    return { denial: "envelope_malformed" };
  }
  if (fingerprint !== authorization.envelopeFingerprint) return { denial: "envelope_malformed" };

  if (
    authorization.provider !== expected.provider ||
    envelope.provider !== expected.provider ||
    session.provider !== expected.provider
  ) {
    return { denial: "provider_mismatch" };
  }
  if (session.accountRef !== expected.accountRef) return { denial: "account_mismatch" };
  if (session.environment !== expected.environment) return { denial: "environment_mismatch" };
  if (envelope.envelope.id !== expected.envelope.id || envelope.envelope.version !== expected.envelope.version) {
    return { denial: "provider_envelope_mismatch" };
  }
  if (fingerprint !== expected.envelopeFingerprint) return { denial: "permit_mismatch" };
  if (authorization.permitId !== envelope.permit.permitId || envelope.permit.permitId !== expected.permitId) {
    return { denial: "permit_mismatch" };
  }
  if (!sameTask(envelope.task, expected.task)) return { denial: "task_lane_mismatch" };
  if (envelope.subject.organizationId !== expected.organizationId) return { denial: "organization_mismatch" };
  if (
    envelope.scope.fingerprint !== expected.scope.fingerprint ||
    envelope.scope.requestedQuantity !== expected.scope.requestedQuantity
  ) {
    return { denial: "scope_mismatch" };
  }
  if (
    authorization.sessionBindingId !== envelope.sessionBindingId ||
    envelope.sessionBindingId !== expected.sessionBindingId
  ) {
    return { denial: "session_binding_mismatch" };
  }
  if (envelope.rollout.capability !== "automatic_quote_collection" || envelope.rollout.revision !== expected.rolloutRevision) {
    return { denial: "rollout_binding_mismatch" };
  }

  const issuedMs = Date.parse(envelope.issuedAt);
  const expiresMs = Date.parse(envelope.expiresAt);
  if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs) || expiresMs <= issuedMs) {
    return { denial: "envelope_malformed" };
  }
  if (authorization.expiresAt !== envelope.expiresAt) return { denial: "expiry_mismatch" };
  if (!Number.isFinite(nowMs) || nowMs < issuedMs) return { denial: "permit_not_yet_valid" };
  if (nowMs >= expiresMs) return { denial: "permit_expired" };
  return { envelope };
}

/** Copies and hashes the caller's bytes; they must match the authorized outbound files exactly. */
function captureFiles(
  envelope: ProviderDispatchEnvelope,
  files: readonly ProviderExecutionCapturedFile[],
): ProviderExecutionFile[] | null {
  if (files.length !== envelope.outboundFiles.length) return null;
  const captured: ProviderExecutionFile[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (!file || !ROLES.includes(file.role) || seen.has(file.role) || !(file.bytes instanceof Uint8Array)) return null;
    seen.add(file.role);
    const authorized = envelope.outboundFiles.find((outbound) => outbound.role === file.role);
    const copy = Uint8Array.from(file.bytes);
    const digest = sha256Hex(copy);
    if (!authorized || authorized.sha256 !== digest || authorized.sourceSha256 !== digest) return null;
    captured.push(
      Object.freeze({
        role: file.role,
        sha256: digest,
        bytes: () => Uint8Array.from(copy),
      }),
    );
  }
  return captured;
}

/**
 * Validates the authorization and, only if every check passes, runs the adapter
 * exactly once. The returned union never includes error text, file bytes, or
 * session material.
 */
export async function executeWithProviderAuthorization<T>(
  request: ProviderExecutionRequest,
  adapter: ProviderExecutionAdapter<T>,
  options: { log?: ProviderExecutionLogger } = {},
): Promise<ProviderExecutionResult<T>> {
  const log = options.log ?? defaultLogger;
  const provider = request?.expected?.provider ?? "unknown";
  const deny = (denial: ProviderExecutionDenialCode): ProviderExecutionResult<T> => {
    log({ event: "provider_execution.denied", provider, denial });
    return { kind: "denied", denial, retryable: isRetryableProviderDispatchDenial(denial as ProviderDispatchDenialCode) };
  };

  if (!request) return deny("execution_request_malformed");
  const checked = authorizationDenial(request, request.nowMs ?? Date.now());
  if ("denial" in checked) return deny(checked.denial);
  const envelope = checked.envelope;

  if (!adapter || adapter.provider !== envelope.provider || typeof adapter.execute !== "function") {
    return deny("adapter_mismatch");
  }
  const files = captureFiles(envelope, request.files);
  if (!files) return deny("captured_file_mismatch");

  const context: ProviderExecutionContext = Object.freeze({
    provider: envelope.provider,
    environment: request.expected.environment,
    permitId: envelope.permit.permitId,
    envelopeFingerprint: request.expected.envelopeFingerprint,
    sessionBindingId: envelope.sessionBindingId,
    requestedQuantity: envelope.scope.requestedQuantity,
    files: Object.freeze(files),
  });

  log({ event: "provider_execution.started", provider: envelope.provider });
  try {
    return { kind: "completed", value: await adapter.execute(context) };
  } catch (error) {
    const outcome = providerExecutionTerminalOutcomeForError(error);
    if (outcome) {
      log({ event: "provider_execution.terminal", provider: envelope.provider, outcome });
      return { kind: "terminal", outcome, disposition: "manual_follow_up", retryable: false };
    }
    log({ event: "provider_execution.failed", provider: envelope.provider });
    return { kind: "adapter_failed", retryable: false };
  }
}
