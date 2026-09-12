import { callRpc } from "@/features/quotes/api/shared/rpc";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_CHARACTERS = 4_000;
const MAX_BODY_BYTES = 8_000;

export type EngineeringInboxSubmissionInput = Readonly<{
  organizationId: string;
  projectId: string;
  conversationId: string;
  inputSnapshotId: string;
  expectedRevision: number;
  idempotencyKey: string;
  body: string;
}>;

export type EngineeringInboxReceipt = Readonly<{
  conversationId: string;
  messageId: string;
  requestId: string;
  revision: number;
  inputSnapshotId: string;
}>;

export type EngineeringInboxSubmissionResult =
  | Readonly<{ status: "submitted"; receipt: EngineeringInboxReceipt }>
  | Readonly<{ status: "conflict"; code: "PT409"; message: string }>
  | Readonly<{ status: "retryable"; code: "40001"; message: string }>
  | Readonly<{ status: "rejected"; code: "22023" | "42501"; message: string }>
  | Readonly<{
    status: "uncertain_delivery";
    reason: "transport" | "unrecognized_response";
    message: string;
  }>;

type EngineeringInboxRpcArgs = Readonly<{
  p_organization_id: string;
  p_project_id: string;
  p_conversation_id: string;
  p_input_snapshot_id: string;
  p_expected_revision: number;
  p_idempotency_key: string;
  p_body: string;
}>;

type RpcError = Readonly<{ code?: string; message?: string }>;
type RpcResponse = Readonly<{
  data: unknown;
  error: RpcError | null;
  status?: number;
}>;
type SubmitRpc = (args: EngineeringInboxRpcArgs) => Promise<RpcResponse>;

function requireUuid(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a UUID.`);
  }
  return value;
}

function validateInput(input: EngineeringInboxSubmissionInput): EngineeringInboxRpcArgs {
  if (
    !Number.isSafeInteger(input.expectedRevision)
    || input.expectedRevision < 0
    || input.expectedRevision >= Number.MAX_SAFE_INTEGER
  ) {
    throw new TypeError("Engineering expected revision must be a non-negative safe integer.");
  }
  if (
    input.body.length < 1
    || input.body.length > MAX_BODY_CHARACTERS
    || new TextEncoder().encode(input.body).byteLength > MAX_BODY_BYTES
    || !/\S/u.test(input.body)
  ) {
    throw new TypeError("Engineering message body does not satisfy the intake contract.");
  }

  return Object.freeze({
    p_organization_id: requireUuid(input.organizationId, "Engineering organization ID"),
    p_project_id: requireUuid(input.projectId, "Engineering project ID"),
    p_conversation_id: requireUuid(input.conversationId, "Engineering conversation ID"),
    p_input_snapshot_id: requireUuid(input.inputSnapshotId, "Engineering input snapshot ID"),
    p_expected_revision: input.expectedRevision,
    p_idempotency_key: requireUuid(input.idempotencyKey, "Engineering idempotency key"),
    p_body: input.body,
  });
}

function requireReceiptUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${label} is not a UUID.`);
  }
  return value;
}

function sameUuid(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function parseReceipt(value: unknown, args: EngineeringInboxRpcArgs): EngineeringInboxReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Engineering intake receipt is not an object.");
  }

  const record = value as Record<string, unknown>;
  const expectedKeys = ["conversationId", "inputSnapshotId", "messageId", "requestId", "revision"];
  const actualKeys = Object.keys(record).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new TypeError("Engineering intake receipt fields do not match the RPC contract.");
  }

  const conversationId = requireReceiptUuid(record.conversationId, "Engineering receipt conversation ID");
  const inputSnapshotId = requireReceiptUuid(record.inputSnapshotId, "Engineering receipt input snapshot ID");
  const messageId = requireReceiptUuid(record.messageId, "Engineering receipt message ID");
  const requestId = requireReceiptUuid(record.requestId, "Engineering receipt request ID");
  const revision = record.revision;

  if (
    !sameUuid(conversationId, args.p_conversation_id)
    || !sameUuid(inputSnapshotId, args.p_input_snapshot_id)
    || revision !== args.p_expected_revision + 1
  ) {
    throw new TypeError("Engineering intake receipt does not match the submitted request identity.");
  }

  return Object.freeze({ conversationId, messageId, requestId, revision, inputSnapshotId });
}

function errorMessage(error: RpcError): string {
  return typeof error.message === "string" && error.message.length > 0
    ? error.message
    : "Engineering intake was rejected without a message.";
}

function classifyError(error: RpcError, status?: number): EngineeringInboxSubmissionResult {
  if (error.code === "PT409" || status === 409) {
    return { status: "conflict", code: "PT409", message: errorMessage(error) };
  }
  if (error.code === "40001") {
    return { status: "retryable", code: "40001", message: errorMessage(error) };
  }
  if (error.code === "22023" || error.code === "42501") {
    return { status: "rejected", code: error.code, message: errorMessage(error) };
  }
  return {
    status: "uncertain_delivery",
    reason: "unrecognized_response",
    message: "Engineering intake returned an unrecognized error; reconcile before changing the request.",
  };
}

async function defaultSubmitRpc(args: EngineeringInboxRpcArgs): Promise<RpcResponse> {
  return callRpc("api_submit_engineering_message", args);
}

/**
 * Binds one browser Send intent to immutable RPC arguments. Retries are explicit,
 * reuse the same identity, and concurrent calls share one network attempt.
 */
export function createEngineeringInboxSubmission(
  input: EngineeringInboxSubmissionInput,
  submitRpc: SubmitRpc = defaultSubmitRpc,
): Readonly<{
  request: EngineeringInboxRpcArgs;
  submit: () => Promise<EngineeringInboxSubmissionResult>;
}> {
  const request = validateInput(input);
  let inFlight: Promise<EngineeringInboxSubmissionResult> | null = null;
  let terminal: EngineeringInboxSubmissionResult | null = null;

  const attempt = async (): Promise<EngineeringInboxSubmissionResult> => {
    let response: RpcResponse;
    try {
      response = await submitRpc(request);
    } catch {
      return {
        status: "uncertain_delivery",
        reason: "transport",
        message: "Engineering intake delivery is uncertain; retry only with this same request identity.",
      };
    }

    if (response.error) {
      return classifyError(response.error, response.status);
    }

    try {
      return { status: "submitted", receipt: parseReceipt(response.data, request) };
    } catch {
      return {
        status: "uncertain_delivery",
        reason: "unrecognized_response",
        message: "Engineering intake returned an invalid receipt; reconcile before changing the request.",
      };
    }
  };

  const submit = (): Promise<EngineeringInboxSubmissionResult> => {
    if (terminal) {
      return Promise.resolve(terminal);
    }
    if (inFlight) {
      return inFlight;
    }

    inFlight = attempt()
      .then((result) => {
        if (result.status === "submitted" || result.status === "conflict" || result.status === "rejected") {
          terminal = result;
        }
        return result;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return Object.freeze({ request, submit });
}
